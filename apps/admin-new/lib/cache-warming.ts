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

// ── PlusVibe request pacing ────────────────────────────────────────────────
// One global gate for EVERY PV call in this process. The combo warmer used to
// fire a whole pass at once (120 ws-days x 9 combos = ~1,080 parallel requests)
// and PV answered with 429s; those failures were swallowed, so days were left
// half-written and the backlog grew every pass. Serialising with a small
// minimum gap keeps us under PV's limit and makes a pass slow-but-complete,
// which is what a cache actually needs.
// Tuned from live logs: at 2 concurrent / 120ms we still hit 429s constantly
// and PV's own Retry-After was 10s every time — its real ceiling is far below
// what we were asking for. Serialise (1 at a time) with a 400ms floor ≈ 2.5
// req/s, which is slower than a burst but finishes; the previous settings
// spent most of their time in backoff anyway, so throughput barely changes.
const PV_CONCURRENCY = 1
const PV_MIN_GAP_MS = 400
const PV_MAX_RETRIES = 6         // was 4; one cell still exhausted retries
const PV_BASE_BACKOFF_MS = 2000
// After a 429 the whole process pauses briefly, not just the failing request.
// Without this every other in-flight call marches into the same wall and each
// burns its own retry budget — which is how a cell exhausted 5 attempts.
const PV_COOLDOWN_MS = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let pvActive = 0
let pvLastStart = 0
// Timestamp until which ALL PV traffic holds off, set when any call sees a 429.
let pvPausedUntil = 0
const pvQueue: Array<() => void> = []

export function pvBackoffSignal(ms: number): void {
  pvPausedUntil = Math.max(pvPausedUntil, Date.now() + ms)
}

async function pvGate<T>(fn: () => Promise<T>): Promise<T> {
  if (pvActive >= PV_CONCURRENCY) {
    await new Promise<void>((resolve) => pvQueue.push(resolve))
  }
  pvActive++
  try {
    // Respect a process-wide cooldown first, then the per-request spacing.
    for (;;) {
      const waitFor = pvPausedUntil - Date.now()
      if (waitFor <= 0) break
      await sleep(Math.min(waitFor, 10_000))
    }
    const since = Date.now() - pvLastStart
    if (since < PV_MIN_GAP_MS) await sleep(PV_MIN_GAP_MS - since)
    pvLastStart = Date.now()
    return await fn()
  } finally {
    pvActive--
    pvQueue.shift()?.()
  }
}

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
  return pvGate(async () => {
    const url = `${PV_BASE}${path}`
    // Retry 429/5xx with backoff. Previously a 429 threw straight out, the
    // caller's allSettled swallowed it, and that combo cell was simply never
    // written — leaving the day permanently short of its 9 rows and its totals
    // silently understated (this was ~33% of agency sends missing).
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { 'x-api-key': PV_KEY },
        signal: AbortSignal.timeout(20000),
      })
      if (res.ok) return await res.json()

      // 400 = PV doesn't recognise the workspace. Permanent: mark it dead so
      // we stop retrying it every pass.
      if (res.status === 400) {
        const m = path.match(/workspace_id=([^&]+)/)
        if (m) deadWorkspaces.add(m[1])
        throw new Error('PlusVibe 400')
      }

      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= PV_MAX_RETRIES) {
        console.error(`[cache-warming] PlusVibe ${res.status} (gave up after ${attempt + 1})`)
        throw new Error(`PlusVibe ${res.status}`)
      }
      // Honour Retry-After when PV sends one, else exponential backoff+jitter.
      const ra = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 30_000)
        : Math.min(PV_BASE_BACKOFF_MS * 2 ** attempt, 30_000) + Math.random() * 250
      // Hold the whole process back too, so queued calls don't each walk into
      // the same limit and burn their own retry budgets in parallel.
      pvBackoffSignal(Math.max(wait, PV_COOLDOWN_MS))
      console.warn(`[cache-warming] PlusVibe ${res.status}, retry ${attempt + 1}/${PV_MAX_RETRIES} in ${Math.round(wait)}ms`)
      await sleep(wait)
    }
  })
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
const TTL_COMBO_RECENT_MS = 6 * 60 * 60 * 1000 // still-moving days: re-check 4×/day
const TTL_COMBO_OLD_MS = 7 * 24 * 60 * 60 * 1000 // settled days: weekly is plenty
// A day's numbers keep moving after the day ends — OOO lands within minutes but
// human replies and bounces trickle in for days. Caching a day as final the
// moment it ends froze it mid-fill (this is why the page showed 50 replies where
// PV's own API had 59). Treat anything inside the settle window as still-moving.
const COMBO_SETTLE_DAYS = 14
function comboTtlFor(date: string, today: string): number {
  if (date === today) return TTL_COMBO_TODAY_MS
  const ageDays = Math.floor(
    (Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86_400_000,
  )
  return ageDays <= COMBO_SETTLE_DAYS ? TTL_COMBO_RECENT_MS : TTL_COMBO_OLD_MS
}

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

  // Freshness is judged on the OLDEST data row, and the '_' sentinel is excluded.
  // Two bugs lived here: the sentinel is re-stamped on every pass, so MAX() over
  // all rows was always fresh and real data never refreshed again; and MAX() over
  // data rows would let one lucky cell mask eight stale ones. MIN() over data
  // rows only means a ws+date refreshes while ANY of its cells is stale.
  const needsFetch: Array<{ wsId: string; date: string; savedAt: number }> = []
  for (const wsId of wsIds) {
    if (deadWorkspaces.has(wsId)) continue
    for (const date of dates) {
      const ttl = comboTtlFor(date, today)
      const res = await pool.query(
        `SELECT MIN(saved_at) AS saved_at, COUNT(*) AS n
           FROM combo_daily_stats
          WHERE ws_id = $1 AND date = $2 AND provider <> '_'`,
        [wsId, date],
      )
      const savedAt = res.rows[0]?.saved_at
      const n = Number(res.rows[0]?.n || 0)
      // n < 9 means some combos were never stored (see the zero-cell fix below),
      // so the day is incomplete regardless of how recently it was touched.
      if (!savedAt || n < ESP_VALUES.length ** 2 || Date.now() - Number(savedAt) > ttl) {
        needsFetch.push({ wsId, date, savedAt: savedAt ? Number(savedAt) : 0 })
      }
    }
  }
  if (!needsFetch.length) return

  // Bound one pass. Each ws-day costs 9 PV calls, now paced through pvGate at
  // ~2 concurrent / 120ms apart — so 12 ws-days ≈ 108 calls ≈ 7s of gating,
  // comfortably inside the 15-min interval with room for retries. The old cap
  // of 120 (1,080 calls) is what triggered the 429 storm. Oldest-stale-first
  // so nothing starves; the next pass takes the rest.
  const MAX_PAIRS_PER_PASS = 12
  let queue = [...needsFetch].sort((a, b) => a.savedAt - b.savedAt)
  if (queue.length > MAX_PAIRS_PER_PASS) {
    console.log(
      `[cache-warming] combo: ${queue.length} stale ws-date pairs, capping this pass at ${MAX_PAIRS_PER_PASS}`,
    )
    queue = queue.slice(0, MAX_PAIRS_PER_PASS)
  }

  console.log(`[cache-warming] combo: fetching ${queue.length} ws-date pairs × 9 combos`)

  // One ws+date at a time; its 9 combos fetched with modest concurrency. Keeps
  // total PV load bounded (needsFetch is usually just today for active ws).
  for (const { wsId, date } of queue) {
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
          // Always store, including all-zero cells. Skipping them meant a combo
          // that was empty at first fetch was never written and never revisited,
          // so it stayed permanently absent from the matrix even once it had
          // real volume — and an absent cell is indistinguishable from a genuine
          // zero. Storing all 9 also lets the freshness check above use row
          // count to detect an incomplete day.
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

// Guard against overlapping passes. A pass now outlives the request that
// started it (fire-and-forget, minutes long), so without this every page load
// would stack another concurrent warm on top — all of them competing for the
// same serialised PV gate and pushing each other into 429 backoff. Declared
// above both users: `let` is not hoisted, so referencing it from an earlier
// line would be a TDZ error at runtime.
let comboWarmInFlight = false

export async function warmComboCache(): Promise<void> {
  // Same guard as warmComboDates: a pass can now run longer than the 15-min
  // interval, so the timer must not stack a second one on top of the first.
  if (comboWarmInFlight) {
    console.log('[cache-warming] combo warm already running, skipping this tick')
    return
  }
  comboWarmInFlight = true
  try {
    const wsIds = await getActiveWorkspaces()
    if (!wsIds.length) return
    // Cover the whole settle window, not just 7 days: a day inside it is still
    // filling in, and the TTL above is what keeps the cost down (a settled day
    // is skipped cheaply). Older windows are still fetched on demand by the route.
    await ensureComboDaily(wsIds, lastNDates(COMBO_SETTLE_DAYS))
    console.log(`[cache-warming] combo cache warmed (${COMBO_SETTLE_DAYS}d)`)
  } catch (err) {
    console.error('[cache-warming] combo warm failed:', err instanceof Error ? err.message : err)
  } finally {
    comboWarmInFlight = false
  }
}

// On-demand combo warm for a specific date list (TTL-guarded). Called by the
// combo-analysis route so a requested window is filled even if the background
// interval hasn't covered it yet.
export async function warmComboDates(dates: string[]): Promise<void> {
  if (comboWarmInFlight) return
  comboWarmInFlight = true
  try {
    const wsIds = await getActiveWorkspaces()
    if (wsIds.length) await ensureComboDaily(wsIds, dates)
  } catch (err) {
    console.error('[cache-warming] warmComboDates failed:', err instanceof Error ? err.message : err)
  } finally {
    comboWarmInFlight = false
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
