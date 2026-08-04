import pool from './db'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

// TTLs: today = 5 min, old = 12h
const TTL_TODAY_MS = 5 * 60 * 1000
const TTL_OLD_MS = 12 * 60 * 60 * 1000

export interface PerfAgg {
  sent: number
  replies: number
  bounces: number
  posReplies: number
  oooReplies: number
  leads: number
}

async function getActiveWorkspaces(): Promise<string[]> {
  try {
    const res = await pool.query(
      `SELECT DISTINCT workspace_id FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id != ''`
    )
    return res.rows.map(r => r.workspace_id)
  } catch (err) {
    console.error('[cache-warming] getActiveWorkspaces failed:', err)
    return []
  }
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function lastNDates(n: number): string[] {
  const dates = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dates.push(dateStr(d))
  }
  return dates
}

async function pvFetch(path: string): Promise<unknown> {
  const res = await fetch(`${PV_BASE}${path}`, {
    headers: { 'x-api-key': PV_KEY },
    // PlusVibe measured at 10-15s per call under 8-way concurrency, so a 15s
    // deadline aborted healthy requests and turned them into cache misses.
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`PlusVibe ${res.status}`)
  return res.json()
}

/**
 * Aggregate one day's PlusVibe email-stats.
 *
 * THROWS on an unusable response rather than returning zeros. A zeroed aggregate
 * is indistinguishable from a real "no sends today" and would be written with a
 * fresh saved_at, so a malformed reply would masquerade as truth for a full TTL.
 * Callers treat a throw as a fetch failure and keep the previous good row.
 *
 * `header` is the requested range's total and `chart` its per-day rows; because
 * we always query a single day the two agree (verified against the live API), but
 * prefer chart and fall back to header so a multi-day call can't silently sum wrong.
 */
function aggregatePvEmailStats(raw: unknown): PerfAgg {
  const obj = raw as { header?: Record<string, number>; chart?: Array<Record<string, number>> } | null
  const rows = Array.isArray(obj?.chart) && obj.chart.length
    ? obj.chart
    : obj?.header
      ? [obj.header]
      : null
  if (!rows) throw new Error(`unusable PV response: ${JSON.stringify(raw).slice(0, 120)}`)

  return rows.reduce<PerfAgg>(
    (a, r) => ({
      sent: a.sent + (r.total_sent_count || 0),
      replies: a.replies + (r.total_reply_count || 0),
      bounces: a.bounces + (r.total_bounce_count || 0),
      posReplies: a.posReplies + (r.total_pos_reply_count || 0),
      oooReplies: a.oooReplies + (r.total_ooo_reply_count || 0),
      leads: 0, // not available from email-stats, loaded separately
    }),
    { sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, leads: 0 }
  )
}

async function ensurePerfCacheDaily(wsIds: string[], dates: string[]): Promise<void> {
  const today = dateStr(new Date())

  // ONE query for every (ws, date) freshness check. This used to be a nested
  // loop issuing a separate round-trip per pair — ~400 sequential queries per
  // cycle against a max:10 pool, which is what drained the pool and stalled the
  // whole warm loop.
  const freshRes = await pool.query(
    `SELECT ws_id, date, saved_at FROM perf_cache_daily
      WHERE ws_id = ANY($1::text[]) AND date = ANY($2::text[])`,
    [wsIds, dates]
  )
  const savedAt = new Map<string, number>()
  for (const r of freshRes.rows as Array<{ ws_id: string; date: string; saved_at: string | number }>) {
    savedAt.set(`${r.ws_id}|${r.date}`, Number(r.saved_at))
  }

  const now = Date.now()
  const needsFetch: Array<{ wsId: string; date: string }> = []
  for (const wsId of wsIds) {
    for (const date of dates) {
      const cached = savedAt.get(`${wsId}|${date}`)
      const ttl = date === today ? TTL_TODAY_MS : TTL_OLD_MS
      if (cached === undefined || now - cached > ttl) needsFetch.push({ wsId, date })
    }
  }

  if (!needsFetch.length) return
  console.log(`[cache-warming] fetching ${needsFetch.length} workspace-date pairs`)

  let ok = 0
  let failed = 0
  const CONC = 8
  for (let i = 0; i < needsFetch.length; i += CONC) {
    await Promise.allSettled(
      needsFetch.slice(i, i + CONC).map(async ({ wsId, date }) => {
        try {
          const data = aggregatePvEmailStats(
            await pvFetch(`/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}`)
          )
          await pool.query(
            `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (ws_id, date) DO UPDATE SET data = $3, saved_at = $4`,
            [wsId, date, JSON.stringify(data), Date.now()]
          )
          ok++
        } catch (err) {
          failed++
          console.error(`[cache-warming] fetch failed for ${wsId} ${date}:`, err instanceof Error ? err.message : err)
          // NEVER overwrite a good row with zeros. The previous version did
          // (`DO UPDATE SET data = zeros`), so a single timeout wiped that
          // workspace-day to 0 and the page reported it as a real "no sends".
          // Seed a retry placeholder ONLY when nothing is cached yet: saved_at 0
          // is always past TTL, so the next cycle retries it.
          const empty: PerfAgg = { sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, leads: 0 }
          await pool
            .query(
              `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (ws_id, date) DO NOTHING`,
              [wsId, date, JSON.stringify(empty)]
            )
            .catch(() => {})
        }
      })
    )
  }
  console.log(`[cache-warming] ${ok} refreshed, ${failed} failed`)
}

// Re-entrancy guard. A full cycle takes 1-4 minutes (PlusVibe answers in 10-15s
// and we fetch 8 at a time), which is longer than the 2-minute interval — so
// without this the runs stacked, each independently hammering the pool and PV.
let inFlight: Promise<void> | null = null

export function warmPerformanceCache(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const startedAt = Date.now()
    try {
      const wsIds = await getActiveWorkspaces()
      if (!wsIds.length) {
        console.log('[cache-warming] no active workspaces')
        return
      }

      // Phase 1: last 7 days — unblocks the Stats page's default view first.
      await ensurePerfCacheDaily(wsIds, lastNDates(7))

      // Phase 2: rest of the current month.
      const today = new Date()
      const monthDates: string[] = []
      const current = new Date(today.getFullYear(), today.getMonth(), 1)
      while (current <= today) {
        monthDates.push(dateStr(current))
        current.setDate(current.getDate() + 1)
      }
      await ensurePerfCacheDaily(wsIds, monthDates)

      console.log(`[cache-warming] cycle complete in ${Math.round((Date.now() - startedAt) / 1000)}s`)
    } catch (err) {
      // The whole cycle aborting used to be silent, so perf_cache_daily froze
      // while /stats kept claiming "Updated just now". Make it loud.
      console.error('[cache-warming] CYCLE ABORTED:', err instanceof Error ? err.message : err)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Newest saved_at across the rows backing a date range — the real cache age. */
export async function perfCacheUpdatedAt(start: string, end: string): Promise<string | null> {
  try {
    const res = await pool.query(
      `SELECT MAX(saved_at)::bigint AS newest FROM perf_cache_daily
        WHERE date >= $1 AND date <= $2 AND saved_at > 0`,
      [start, end]
    )
    const newest = Number(res.rows[0]?.newest)
    return newest > 0 ? new Date(newest).toISOString() : null
  } catch {
    return null
  }
}

let isInitialized = false

export async function startCacheWarmingInterval(): Promise<void> {
  if (isInitialized) return
  isInitialized = true

  setTimeout(() => {
    warmPerformanceCache().catch(() => {})
  }, 5000)

  const INTERVAL_MS = 2 * 60 * 1000
  setInterval(() => {
    warmPerformanceCache().catch(() => {})
  }, INTERVAL_MS)

  console.log('[cache-warming] interval started (2 min)')
}

// Auto-initialize when module is imported (only on server)
if (typeof window === 'undefined' && typeof global !== 'undefined') {
  startCacheWarmingInterval().catch(console.error)
}
