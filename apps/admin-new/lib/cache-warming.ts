import pool from './db'
import { getActiveWorkspaceIds } from './active-clients'
import { recomputeAll } from './newlead-cache'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

// TTLs: today = 5 min, old = 12h
const TTL_TODAY_MS = 5 * 60 * 1000
const TTL_OLD_MS = 12 * 60 * 60 * 1000

// Workspaces PlusVibe returns 400 for (deleted/unknown). Skipped on subsequent
// passes so we don't repeatedly fail+retry them and stall the warm.
const deadWorkspaces = new Set<string>()

// Only warm workspaces that are ACTIVE clients (legacy /api/client-status) AND
// not already known-dead in PlusVibe. workspace_stats is polluted with stale/
// test/deleted workspaces that 400 or return all-zeros, which spammed PV and
// wasted the warm pass. Intersect with the active-client list (fails open: if
// the status list is unavailable, fall back to all of workspace_stats).
async function getActiveWorkspaces(): Promise<string[]> {
  try {
    const res = await pool.query(
      `SELECT DISTINCT workspace_id FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id != ''`
    )
    let ids = res.rows.map((r) => r.workspace_id as string)
    const active = await getActiveWorkspaceIds().catch(() => null)
    if (active) ids = ids.filter((id) => active.has(id))
    return ids.filter((id) => !deadWorkspaces.has(id))
  } catch (err) {
    console.error('[cache-warming] getActiveWorkspaces failed:', err)
    return []
  }
}

// Europe/London — MUST match the dashboard's period-filter (which resolves
// "today"/ranges in London). Previously this was UTC, so the warmer's "today"
// key and TTL disagreed with the date the dashboard reads near day boundaries,
// leaving the live row stale (wrong TTL) and creating duplicate UTC/London rows.
function dateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d)
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
    // 400 here means PV doesn't recognise the workspace — mark it dead so we
    // stop retrying it. Extract workspace_id from the query string.
    if (res.status === 400) {
      const m = path.match(/workspace_id=([^&]+)/)
      if (m) deadWorkspaces.add(m[1])
    }
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
    return { sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, contacted: 0, leads: 0 }
  }

  const agg = {
    sent: header.total_sent_count ?? 0,
    replies: header.total_reply_count ?? 0,
    bounces: header.total_bounce_count ?? 0,
    posReplies: header.total_pos_reply_count ?? 0,
    oooReplies: header.total_ooo_reply_count ?? 0,
    // People contacted (distinct leads emailed), NOT total emails sent — this is
    // the denominator for LPT (Contacts-To-Lead). Falls back to sent if PV omits it.
    contacted: header.total_contacted_count ?? header.total_sent_count ?? 0,
    leads: 0, // Not available from email-stats, loaded separately
  }
  console.log(`[cache-warming] aggregated: sent=${agg.sent} replies=${agg.replies} ooo=${agg.oooReplies}`)
  return agg
}

// Fetch ONE workspace+date directly from PlusVibe and return the aggregated
// stats (or null on failure). Exported so the stats summary route can LIVE-FILL
// any cache row that is missing / seeded-zero / stale — guaranteeing the
// dashboard equals live PV even when the background warm hasn't run. Reuses the
// exact same field mapping as the warmer so the numbers can never fork.
export async function fetchPvDay(
  wsId: string,
  date: string,
): Promise<Record<string, number> | null> {
  if (!PV_KEY || deadWorkspaces.has(wsId)) return null
  try {
    const raw = await pvFetch(
      `/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}`,
    )
    return aggregatePvEmailStats(raw)
  } catch {
    return null
  }
}

// Best-effort upsert of a freshly-fetched day into the cache (so the next read
// is warm). Never throws.
export async function upsertPerfDay(
  wsId: string,
  date: string,
  data: Record<string, number>,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ws_id, date) DO UPDATE SET data = $3, saved_at = $4`,
      [wsId, date, JSON.stringify(data), Date.now()],
    )
    .catch(() => {})
}

async function ensurePerfCacheDaily(wsIds: string[], dates: string[]): Promise<void> {
  const today = dateStr(new Date())

  // Find which (wsId, date) pairs need fetching
  const needsFetch: Array<{ wsId: string; date: string }> = []

  for (const wsId of wsIds) {
    // Skip workspaces PlusVibe rejects (400 = dead/unknown). Avoids hammering
    // PV with dozens of failing+retrying requests that hang the warm pass.
    if (deadWorkspaces.has(wsId)) continue
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
          // DO NOT overwrite a previously-good row on failure. The old behavior
          // wrote an all-zero placeholder, which on a transient/auth failure
          // (e.g. PlusVibe 400) WIPED real stats for every workspace. Only seed
          // a zero row if NONE exists yet (so the page isn't blank), and never
          // clobber existing data.
          await pool.query(
            `INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (ws_id, date) DO NOTHING`,
            [wsId, date, JSON.stringify({ sent: 0, replies: 0, bounces: 0, posReplies: 0, oooReplies: 0, contacted: 0, leads: 0 })]
          ).catch(() => {})
        }
      })
    )

    const failed = results.filter(r => r.status === 'rejected').length
    if (failed) console.warn(`[cache-warming] ${failed}/${batch.length} fetches failed`)
  }
}

// On-demand warm for a specific set of dates (TTL-guarded inside
// ensurePerfCacheDaily, so calling it per stats request is cheap and only hits
// PlusVibe when a row is stale). Used by the summary route so stats are fresh
// even if the background interval doesn't survive the serverless runtime.
export async function warmDates(dates: string[]): Promise<void> {
  try {
    const wsIds = await getActiveWorkspaces()
    if (wsIds.length) await ensurePerfCacheDaily(wsIds, dates)
  } catch (err) {
    console.error('[cache-warming] warmDates failed:', err instanceof Error ? err.message : err)
  }
}

// ── Combo (sender ESP × recipient ESP) daily stats ──────────────────────────
// MEASURED per combo via /account/email-stats provider + recp_provider filters
// (verified to segment: unfiltered total = sum of provider buckets = sum of
// recp_provider buckets). Stored in combo_daily_stats, read by the Combo
// Analysis page. Sends/replies/bounce/OOO/pos are all real PV numbers — no
// apportioning, no incomplete email_events.
const ESP_VALUES = ['GOOGLE_WORKSPACE', 'MICROSOFT365', 'REGULAR_ACCOUNT'] as const
const TTL_COMBO_TODAY_MS = 30 * 60 * 1000 // combos are heavier (9 calls/day) → 30 min today
const TTL_COMBO_OLD_MS = 24 * 60 * 60 * 1000

let comboTableReady = false
async function ensureComboTable(): Promise<void> {
  if (comboTableReady) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS combo_daily_stats (
       ws_id TEXT NOT NULL, date TEXT NOT NULL,
       provider TEXT NOT NULL, recp_provider TEXT NOT NULL,
       data JSONB NOT NULL, saved_at BIGINT NOT NULL,
       PRIMARY KEY (ws_id, date, provider, recp_provider)
     )`,
  )
  comboTableReady = true
}

async function ensureComboDaily(wsIds: string[], dates: string[]): Promise<void> {
  await ensureComboTable()
  const today = dateStr(new Date())

  // A combo cell is "fresh" if ANY of its 9 rows for that ws+date is within TTL.
  // We refetch a whole ws+date's 9 combos together (one settled check per ws+date).
  const needsFetch: Array<{ wsId: string; date: string }> = []
  for (const wsId of wsIds) {
    if (deadWorkspaces.has(wsId)) continue
    for (const date of dates) {
      const ttl = date === today ? TTL_COMBO_TODAY_MS : TTL_COMBO_OLD_MS
      const res = await pool.query(
        `SELECT MAX(saved_at) AS saved_at FROM combo_daily_stats WHERE ws_id = $1 AND date = $2`,
        [wsId, date],
      )
      const savedAt = res.rows[0]?.saved_at
      if (!savedAt || Date.now() - Number(savedAt) > ttl) needsFetch.push({ wsId, date })
    }
  }
  if (!needsFetch.length) return

  console.log(`[cache-warming] combo: fetching ${needsFetch.length} ws-date pairs × 9 combos`)

  // One ws+date at a time; its 9 combos fetched with modest concurrency. Keeps
  // total PV load bounded (needsFetch is usually just today for active ws).
  for (const { wsId, date } of needsFetch) {
    const pairs: Array<{ provider: string; recp: string }> = []
    for (const provider of ESP_VALUES) for (const recp of ESP_VALUES) pairs.push({ provider, recp })

    const now = Date.now()
    await Promise.allSettled(
      pairs.map(async ({ provider, recp }) => {
        try {
          const raw = await pvFetch(
            `/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}` +
              `&provider=${provider}&recp_provider=${recp}`,
          )
          const data = aggregatePvEmailStats(raw)
          // Skip storing empty cells to keep the table lean, but always clear a
          // stale non-empty row if it went to zero by upserting when sent>0.
          if (!data.sent && !data.replies && !data.bounces) return
          await pool.query(
            `INSERT INTO combo_daily_stats (ws_id, date, provider, recp_provider, data, saved_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (ws_id, date, provider, recp_provider)
               DO UPDATE SET data = $5, saved_at = $6`,
            [wsId, date, provider, recp, JSON.stringify(data), now],
          )
        } catch (err) {
          console.error(
            `[cache-warming] combo fetch failed ${wsId} ${date} ${provider}->${recp}:`,
            err instanceof Error ? err.message : err,
          )
        }
      }),
    )
    // Touch a sentinel so a ws+date with all-empty combos is still considered
    // "fetched" (freshness check reads MAX(saved_at) across its rows).
    await pool
      .query(
        `INSERT INTO combo_daily_stats (ws_id, date, provider, recp_provider, data, saved_at)
         VALUES ($1,$2,'_','_','{}'::jsonb,$3)
         ON CONFLICT (ws_id, date, provider, recp_provider) DO UPDATE SET saved_at = $3`,
        [wsId, date, now],
      )
      .catch(() => {})
  }
}

export async function warmComboCache(): Promise<void> {
  try {
    const wsIds = await getActiveWorkspaces()
    if (!wsIds.length) return
    // Last 7 days is enough for the default Combo view; older windows fetched
    // on demand by the route if needed.
    await ensureComboDaily(wsIds, lastNDates(7))
    console.log('[cache-warming] combo cache warmed (7d)')
  } catch (err) {
    console.error('[cache-warming] combo warm failed:', err instanceof Error ? err.message : err)
  }
}

// On-demand combo warm for a specific date list (TTL-guarded). Called by the
// combo-analysis route so a requested window is filled even if the background
// interval hasn't covered it yet.
export async function warmComboDates(dates: string[]): Promise<void> {
  try {
    const wsIds = await getActiveWorkspaces()
    if (wsIds.length) await ensureComboDaily(wsIds, dates)
  } catch (err) {
    console.error('[cache-warming] warmComboDates failed:', err instanceof Error ? err.message : err)
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
  // Combo cache is heavier (9 calls/ws/day); warm a bit later and less often.
  setTimeout(() => {
    warmComboCache().catch(() => {})
  }, 20000)

  // Then every 2 minutes (same as legacy)
  const INTERVAL_MS = 2 * 60 * 1000
  setInterval(() => {
    warmPerformanceCache().catch(() => {})
  }, INTERVAL_MS)
  // Combo every 15 min — its TTL (30 min today) means most passes are no-ops.
  const COMBO_INTERVAL_MS = 15 * 60 * 1000
  setInterval(() => {
    warmComboCache().catch(() => {})
  }, COMBO_INTERVAL_MS)

  // New-lead/follow-up split: precompute ALL workspaces × standard windows.
  // Slow (~11 min) so run once ~2 min after boot, then every 12h. The agency
  // Combo view reads the cache instantly; an on-demand button can refresh it.
  setTimeout(() => {
    recomputeAll().catch(() => {})
  }, 120_000)
  const NEWLEAD_INTERVAL_MS = 12 * 60 * 60 * 1000
  setInterval(() => {
    recomputeAll().catch(() => {})
  }, NEWLEAD_INTERVAL_MS)

  console.log('[cache-warming] interval started (perf 2 min, combo 15 min, new-lead 12 h)')
}

// Auto-initialize when module is imported (only on server)
if (typeof window === 'undefined' && typeof global !== 'undefined') {
  startCacheWarmingInterval().catch(console.error)
}
