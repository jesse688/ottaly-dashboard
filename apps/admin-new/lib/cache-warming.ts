import pool from './db'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

// TTLs: today = 5 min, old = 12h
const TTL_TODAY_MS = 5 * 60 * 1000
const TTL_OLD_MS = 12 * 60 * 60 * 1000

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

async function pvFetch(path: string): Promise<any> {
  const url = `${PV_BASE}${path}`
  console.log(`[cache-warming] fetching ${url}`)
  const res = await fetch(url, {
    headers: { 'x-api-key': PV_KEY },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const err = `PlusVibe ${res.status}`
    console.error(`[cache-warming] ${err}`)
    throw new Error(err)
  }
  const data = await res.json()
  console.log(`[cache-warming] got response:`, JSON.stringify(data).slice(0, 200))
  return data
}

function aggregatePvEmailStats(raw: any): Record<string, number> {
  const header = raw?.header
  if (!header) {
    console.warn('[cache-warming] no header in PV response:', JSON.stringify(raw).slice(0, 100))
    return { sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, leads: 0 }
  }

  const agg = {
    sent: header.total_sent_count ?? 0,
    replies: header.total_reply_count ?? 0,
    bounces: header.total_bounce_count ?? 0,
    posReplies: header.total_pos_reply_count ?? 0,
    oooReplies: header.total_ooo_reply_count ?? 0,
    leads: 0, // Not available from email-stats, loaded separately
  }
  console.log(`[cache-warming] aggregated: sent=${agg.sent} replies=${agg.replies} ooo=${agg.oooReplies}`)
  return agg
}

async function ensurePerfCacheDaily(wsIds: string[], dates: string[]): Promise<void> {
  const today = dateStr(new Date())

  // Find which (wsId, date) pairs need fetching
  const needsFetch: Array<{ wsId: string; date: string }> = []

  for (const wsId of wsIds) {
    for (const date of dates) {
      // Check if we have fresh cached data
      const ttl = date === today ? TTL_TODAY_MS : TTL_OLD_MS
      const res = await pool.query(
        `SELECT saved_at FROM perf_cache_daily WHERE ws_id = $1 AND date = $2`,
        [wsId, date]
      )

      const cached = res.rows[0]
      if (!cached || Date.now() - cached.saved_at > ttl) {
        needsFetch.push({ wsId, date })
      }
    }
  }

  if (!needsFetch.length) {
    console.log('[cache-warming] cache fresh, no fetches needed')
    return
  }

  console.log(`[cache-warming] fetching ${needsFetch.length} workspace-date pairs`)

  // Fetch up to 8 concurrently (same as legacy)
  const CONC = 8
  for (let i = 0; i < needsFetch.length; i += CONC) {
    const batch = needsFetch.slice(i, i + CONC)
    const results = await Promise.allSettled(
      batch.map(async ({ wsId, date }) => {
        try {
          const raw = await pvFetch(`/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}`)
          const data = aggregatePvEmailStats(raw)

          // Upsert into Postgres (saved_at is Unix ms timestamp)
          const now = Date.now()
          await pool.query(
            `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (ws_id, date) DO UPDATE SET data = $3, saved_at = $4`,
            [wsId, date, JSON.stringify(data), now]
          )
        } catch (err) {
          console.error(`[cache-warming] fetch failed for ${wsId} ${date}:`, err instanceof Error ? err.message : err)
          // Insert stale placeholder (savedAt = 0) so we retry next time
          const empty = { sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, leads: 0 }
          await pool.query(
            `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (ws_id, date) DO UPDATE SET data = $3, saved_at = 0`,
            [wsId, date, JSON.stringify(empty)]
          ).catch(() => {})
        }
      })
    )

    const failed = results.filter(r => r.status === 'rejected').length
    if (failed) console.warn(`[cache-warming] ${failed}/${batch.length} fetches failed`)
  }
}

export async function warmPerformanceCache(): Promise<void> {
  try {
    const wsIds = await getActiveWorkspaces()
    if (!wsIds.length) {
      console.log('[cache-warming] no active workspaces')
      return
    }

    // Phase 1: last 7 days (unblock Stats page immediately)
    const sevenDayDates = lastNDates(7)
    await ensurePerfCacheDaily(wsIds, sevenDayDates)
    console.log(`[cache-warming] phase 1 complete — 7 workspaces × 7 days`)

    // Phase 2: full month (background)
    const today = new Date()
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const monthDates = []
    let current = new Date(monthStart)
    while (current <= today) {
      monthDates.push(dateStr(current))
      current.setDate(current.getDate() + 1)
    }
    await ensurePerfCacheDaily(wsIds, monthDates)
    console.log(`[cache-warming] phase 2 complete — full month updated`)
  } catch (err) {
    console.error('[cache-warming] failed:', err instanceof Error ? err.message : err)
  }
}

let isInitialized = false

export async function startCacheWarmingInterval(): Promise<void> {
  if (isInitialized) return
  isInitialized = true

  // Warm immediately on startup (after a short delay to let DB connect)
  setTimeout(() => {
    warmPerformanceCache().catch(() => {})
  }, 5000)

  // Then every 2 minutes (same as legacy)
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
