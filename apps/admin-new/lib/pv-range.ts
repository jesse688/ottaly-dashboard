import pool from './db'

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTIVE PV CLIENT — deliberately NOT the warmers' pvFetch.
//
// pvFetch shares a process-wide gate AND a process-wide backoff: any 429 from
// the background warmers sets `pausedUntil` for EVERYONE, and each further 429
// extends it. A page request would acquire its slot (priority ordering worked)
// and then sit in that cooldown until its budget expired — measured on live at
// 25.689s / 25.694s / 25.692s, three for three, pinned to the budget, while
// PlusVibe served the very same call directly in 0.67s.
//
// Priority ordering cannot beat a global pause, so the page needs its own
// client. This one is bounded and polite in its own right: at most
// PV_UI_CONCURRENCY in flight, a short timeout, one quick retry, and NO global
// pause — a warmer 429 can no longer freeze a human's page load.
//
// It is a small, fixed amount of extra traffic (one call per workspace per
// range, then cached), which is what makes it safe to keep separate.
// ─────────────────────────────────────────────────────────────────────────────

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''
const PV_UI_CONCURRENCY = Number(process.env.STATS_UI_CONCURRENCY ?? 6)
const PV_UI_TIMEOUT_MS = Number(process.env.STATS_UI_TIMEOUT_MS ?? 12000)

interface UiGate { active: number; queue: Array<() => void> }
const uiGate: UiGate = ((globalThis as Record<string, unknown>).__ottalyPvUiGate ??= {
  active: 0,
  queue: [],
}) as UiGate

async function uiFetch(path: string): Promise<unknown> {
  if (uiGate.active >= PV_UI_CONCURRENCY) {
    await new Promise<void>(r => uiGate.queue.push(r))
  }
  uiGate.active++
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${PV_BASE}${path}`, {
        headers: { 'x-api-key': PV_KEY },
        signal: AbortSignal.timeout(PV_UI_TIMEOUT_MS),
      })
      if (res.ok) return await res.json()
      // One short retry for a transient limit, then give up and let the caller
      // report the workspace as unknown. Never a process-wide pause.
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise(r => setTimeout(r, 600))
        continue
      }
      throw new Error(`PlusVibe ${res.status}`)
    }
    throw new Error('PlusVibe retry exhausted')
  } finally {
    uiGate.active--
    uiGate.queue.shift()?.()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PlusVibe range stats — THE source of truth for the Stats page.
//
// Why this exists: the page used to divide a FULL-WINDOW reply numerator (from
// our unibox) by a PARTIAL-WINDOW sent denominator (from perf_cache_daily,
// which had missing and seeded-zero days). Proven on ButterflyEco 2026-08-01..25:
// PV said 21,746 sent, the cache had 11,554 — six whole send-days were absent —
// so Human RR read 1.96% when the truth was 1.04%, and Reply Rate w/OOO read
// 9.86% against a true 4.94%. Everything was inflated ~2x.
//
// The fix is structural, not a bigger cache: ask PV for the WHOLE range in ONE
// call per workspace and take numerator and denominator from the SAME response.
// They then cannot disagree, whatever the cache is doing. PV returns the daily
// breakdown in the same payload, so the chart series comes from it too.
// ─────────────────────────────────────────────────────────────────────────────

export interface PvDay {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  contacted: number
}

export interface PvRange {
  totals: Omit<PvDay, 'date'>
  series: PvDay[]
}

// PV's per-day chart entry. Only the fields we consume are named.
interface PvChartRow {
  date?: string
  total_sent_count?: number
  total_reply_count?: number
  total_ooo_reply_count?: number
  total_bounce_count?: number
  total_contacted_count?: number
  total_pos_reply_count?: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Fetch one workspace's stats for an inclusive date range in a SINGLE PV call.
 *
 * Returns null on failure — callers MUST treat null as "unknown", never as
 * zero. A zero here would silently shrink the denominator and re-create exactly
 * the inflation bug this module was written to kill.
 */
export async function fetchPvRange(
  wsId: string,
  start: string,
  end: string,
): Promise<PvRange | null> {
  let raw: unknown
  try {
    raw = await uiFetch(
      `/account/email-stats?workspace_id=${encodeURIComponent(wsId)}` +
        `&start_date=${start}&end_date=${end}`,
    )
  } catch {
    return null
  }

  const body = raw as { header?: Record<string, unknown>; chart?: PvChartRow[] } | null
  const header = body?.header
  // No header = a shape we don't understand. Unknown, not zero.
  if (!header) return null

  // Totals come from PV's own header rather than a sum over `chart`, so they
  // match what PV's UI shows for the same range exactly.
  const totals = {
    sent: num(header.total_sent_count),
    replies: num(header.total_reply_count),
    posReplies: num(header.total_pos_reply_count),
    oooReplies: num(header.total_ooo_reply_count),
    bounces: num(header.total_bounce_count),
    // THE REPLY-RATE DENOMINATOR.
    //
    // This is the PUBLIC PlusVibe API (api.plusvibe.ai/api/v1), which is NOT
    // the same shape as the MCP tool of a similar name. The public API has no
    // `total_unique_contacted_count` at all — reading it returned undefined,
    // the rate divided by zero, and every workspace was dropped as "failed",
    // which is why the page showed nothing. Same metric, different field name,
    // different endpoint.
    //
    // Verified against PV's OWN published rates on the public API across four
    // windows — dividing by total_contacted_count reproduces reply_rate and
    // reply_rate_with_ooo exactly every time:
    //   2026-06-17..08-26  1.21->1.2   5.55->5.6
    //   2026-08-01..08-25  1.26->1.3   6.00->6.0
    //   2026-06-01..06-30  1.05->1.0   3.00->3.0
    //   all time           1.44->1.4   5.48->5.5
    // Dividing by `sent` is low in all eight cases. Bounce rate is the
    // exception and genuinely does divide by sent (0.58/0.59/0.45 -> 0.6/0.6/0.4).
    contacted: num(header.total_contacted_count),
    }

  const series: PvDay[] = (Array.isArray(body?.chart) ? body.chart : [])
    .filter((d): d is PvChartRow & { date: string } => typeof d?.date === 'string')
    .map(d => ({
      date: d.date,
      sent: num(d.total_sent_count),
      replies: num(d.total_reply_count),
      posReplies: num(d.total_pos_reply_count),
      oooReplies: num(d.total_ooo_reply_count),
      bounces: num(d.total_bounce_count),
      contacted: num(d.total_contacted_count),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { totals, series }
}

/**
 * Fetch many workspaces' ranges concurrently.
 *
 * `uiFetch` bounds its own concurrency, so this only controls how many are
 * queued. Failures are reported by workspace id rather than swallowed —
 * the route needs to know precisely which rows are untrustworthy so it can
 * refuse to print a rate for them.
 */
export async function fetchPvRanges(
  wsIds: string[],
  start: string,
  end: string,
): Promise<{ byWs: Map<string, PvRange>; failed: string[] }> {
  const byWs = new Map<string, PvRange>()
  const failed: string[] = []

  const CONC = 6
  for (let i = 0; i < wsIds.length; i += CONC) {
    const batch = wsIds.slice(i, i + CONC)
    const results = await Promise.allSettled(
      batch.map(async id => ({ id, range: await fetchPvRange(id, start, end) })),
    )
    for (const [j, r] of results.entries()) {
      if (r.status === 'fulfilled' && r.value.range) byWs.set(r.value.id, r.value.range)
      else failed.push(batch[j])
    }
  }

  return { byWs, failed }
}

// ─────────────────────────────────────────────────────────────────────────────
// RANGE CACHE
//
// Calling PV inline on every page load made the page unusable: pvFetch shares
// ONE process-wide gate (PV_CONCURRENCY=1, 400ms floor) with the background
// cache warmer, which fires up to 40 calls every 2 minutes. A page request
// queued behind that backlog — a single workspace timed out at 100s.
//
// So the page must never wait on PV. It reads this cache (one Postgres row per
// workspace+range) and PV refreshes happen in the background. The accuracy
// property that matters is preserved: every row is still ONE PV response, so
// numerator and denominator always come from the same source and window. Only
// the freshness changes, and a stale-but-consistent row is served with its age
// so the page can say how old it is.
// ─────────────────────────────────────────────────────────────────────────────


const RANGE_TTL_MS = Number(process.env.STATS_RANGE_TTL_MS ?? 15 * 60 * 1000)

let schemaReady: Promise<void> | null = null
function ensureSchema(): Promise<void> {
  schemaReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS pv_range_cache (
         ws_id TEXT NOT NULL,
         start_date DATE NOT NULL,
         end_date DATE NOT NULL,
         data JSONB NOT NULL,
         saved_at BIGINT NOT NULL,
         PRIMARY KEY (ws_id, start_date, end_date)
       )`,
    )
    .then(() => undefined)
    .catch(err => {
      schemaReady = null // let a later call retry
      throw err
    })
  return schemaReady
}

export interface CachedRange {
  range: PvRange
  savedAt: number
  stale: boolean
}

/** Read cached ranges for many workspaces in one query. Never throws. */
export async function readRangeCache(
  wsIds: string[],
  start: string,
  end: string,
): Promise<Map<string, CachedRange>> {
  const out = new Map<string, CachedRange>()
  if (!wsIds.length) return out
  try {
    await ensureSchema()
    const res = await pool.query(
      `SELECT ws_id, data, saved_at
         FROM pv_range_cache
        WHERE start_date = $1::date AND end_date = $2::date AND ws_id = ANY($3::text[])`,
      [start, end, wsIds],
    )
    const now = Date.now()
    for (const r of res.rows as Array<{ ws_id: string; data: PvRange; saved_at: string | number }>) {
      const savedAt = Number(r.saved_at) || 0
      out.set(String(r.ws_id), {
        range: r.data,
        savedAt,
        stale: now - savedAt > RANGE_TTL_MS,
      })
    }
  } catch {
    // A cache miss is survivable; a thrown error would blank the page.
  }
  return out
}

/** Best-effort write of one workspace's range. Never throws. */
export async function writeRangeCache(
  wsId: string,
  start: string,
  end: string,
  range: PvRange,
): Promise<void> {
  try {
    await ensureSchema()
    await pool.query(
      `INSERT INTO pv_range_cache (ws_id, start_date, end_date, data, saved_at)
       VALUES ($1,$2::date,$3::date,$4,$5)
       ON CONFLICT (ws_id, start_date, end_date)
       DO UPDATE SET data = $4, saved_at = $5`,
      [wsId, start, end, JSON.stringify(range), Date.now()],
    )
  } catch {
    /* cache write failure must never break a request */
  }
}

// One in-flight refresh per workspace+range, process-wide. Without this, every
// page load for a stale range would spawn another PV call and rebuild exactly
// the queue this cache exists to avoid.
const inflight: Set<string> = ((globalThis as Record<string, unknown>)
  .__ottalyRangeRefresh ??= new Set<string>()) as Set<string>

/**
 * Kick a background refresh for one workspace+range. Returns immediately —
 * the caller must NOT await the PV work, only the scheduling.
 */
export function refreshRangeInBackground(wsId: string, start: string, end: string): void {
  const key = `${wsId}|${start}|${end}`
  if (inflight.has(key)) return
  inflight.add(key)
  void (async () => {
    try {
      const range = await fetchPvRange(wsId, start, end)
      if (range) await writeRangeCache(wsId, start, end, range)
    } catch {
      /* a failed refresh just leaves the previous row in place */
    } finally {
      inflight.delete(key)
    }
  })()
}
