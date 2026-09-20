/**
 * Mailbox health: burn, placement and recovery.
 *
 * Answers what mailbox-sync cannot: how much each mailbox has SPENT over its
 * whole life, and therefore how long it has left.
 *
 * PlusVibe has no lifetime send count and rejects any date range over 90 days
 * ("end_date: Date range must not exceed 90 days"), so cumulative sends have to
 * be stitched from consecutive windows and banked. A day that is not stored
 * before it falls out of PlusVibe's reach cannot be recovered — which is why
 * mbx_daily rows are immutable once written and why this never recomputes, only
 * appends.
 *
 * WHY THIS MATTERS. Measured across the estate: mailboxes die from cumulative
 * sends, not age. Hayes & Co died at 369 sends/mailbox; Accrue is past 1,200
 * and still improving, because it rests half its life. Cumulative sends
 * correlate with OOO rate at -0.218 against age's -0.088.
 *
 * Never add a second PV limiter here — pvGate in lib/pv-gate.ts is the only
 * one, and a second doubles the real request rate into permanent 429 backoff.
 */

import pool from './db'
import {
  pvGate,
  pvBackoffSignal,
  pvBeginBulk,
  pvBulkActive,
  PV_MAX_RETRIES,
  PV_BASE_BACKOFF_MS,
  PV_COOLDOWN_MS,
} from './pv-gate'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? process.env.PLUSVIBE_API_KEY ?? ''

/** PlusVibe's hard limit on a stats date range. Not ours to choose. */
const MAX_WINDOW_DAYS = 90
/** Mailboxes per bulk stats call. */
const CHUNK = 100

/**
 * Working threshold for cumulative sends before decline sets in. Confirmed
 * three ways (Hayes 369, Bubble 448, Winnr curve) but treat as a 300-450 range,
 * not a cliff — a mailbox that rests can go far past it.
 */
export const BURN_THRESHOLD = 350

/**
 * Never judge a mailbox on fewer than this many contacted. At 25 sends and a 6%
 * OOO rate, chance alone puts P(zero OOO) at ~21%, which nearly retired 16
 * healthy Northern mailboxes.
 */
export const MIN_JUDGE = 100

// ── schema ───────────────────────────────────────────────────────────────────
// Memoised so the tables exist without a manual psql step, nulling itself on
// failure so a later call retries. Same shape as lib/pv-range.ts.
let schemaReady: Promise<void> | null = null
export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_daily (
        email     text NOT NULL,
        date      date NOT NULL,
        sent      integer NOT NULL DEFAULT 0,
        ooo       integer NOT NULL DEFAULT 0,
        replies   integer NOT NULL DEFAULT 0,
        positive  integer NOT NULL DEFAULT 0,
        contacted integer NOT NULL DEFAULT 0,
        bounce    integer NOT NULL DEFAULT 0,
        PRIMARY KEY (email, date)
      )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mbx_daily_date ON mbx_daily (date)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_window (
        email            text NOT NULL,
        start_date       date NOT NULL,
        end_date         date NOT NULL,
        sent             integer NOT NULL DEFAULT 0,
        ooo              integer NOT NULL DEFAULT 0,
        replies          integer NOT NULL DEFAULT 0,
        positive         integer NOT NULL DEFAULT 0,
        contacted        integer NOT NULL DEFAULT 0,
        bounce           integer NOT NULL DEFAULT 0,
        recipient_bounce integer NOT NULL DEFAULT 0,
        sender_bounce    integer NOT NULL DEFAULT 0,
        PRIMARY KEY (email, start_date, end_date)
      )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mbx_window_email ON mbx_window (email)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_client_state (
        workspace_name text PRIMARY KEY,
        state          text NOT NULL DEFAULT 'active',
        note           text,
        changed_at     timestamptz NOT NULL DEFAULT now()
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_ingest_run (
        id          bigserial PRIMARY KEY,
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        kind        text,
        workspaces  integer,
        mailboxes   integer,
        api_calls   integer,
        errors      integer,
        note        text
      )`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_placement (
        test_id   text NOT NULL,
        email     text NOT NULL,
        rec_type  text NOT NULL,
        sent      integer NOT NULL DEFAULT 0,
        inbox     integer NOT NULL DEFAULT 0,
        spam      integer NOT NULL DEFAULT 0,
        promotion integer NOT NULL DEFAULT 0,
        missing   integer NOT NULL DEFAULT 0,
        tested_at timestamptz,
        PRIMARY KEY (test_id, email, rec_type)
      )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mbx_placement_email ON mbx_placement (email)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mbx_placement_run (
        test_id      text PRIMARY KEY,
        parent_id    text,
        workspace_id text,
        name         text,
        status       text,
        sent         integer,
        inbox        integer,
        inbox_pct    numeric,
        spam_pct     numeric,
        created_at   timestamptz,
        fetched_at   timestamptz NOT NULL DEFAULT now()
      )`)
    // mailbox_full is shared with mailbox-sync; only ever ADD to it.
    for (const col of ['flagged_reason text', 'flagged_at timestamptz', 'paused_at timestamptz']) {
      await pool.query(`ALTER TABLE mailbox_full ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {})
    }
  })().catch(err => { schemaReady = null; throw err })
  return schemaReady
}

// ── PlusVibe ─────────────────────────────────────────────────────────────────
// Copied from lib/mailbox-sync.ts. Goes through the shared gate; never its own.
async function pvFetch<T>(path: string): Promise<T | null> {
  if (!PV_KEY) return null
  return pvGate(async () => {
    for (let attempt = 0; attempt < PV_MAX_RETRIES; attempt++) {
      const res = await fetch(`${PV_BASE}${path}`, {
        headers: { 'x-api-key': PV_KEY },
        signal: AbortSignal.timeout(20000),
      }).catch(() => null)
      if (!res) return null
      if (res.status === 429) {
        // Pause the SHARED queue so mailbox-sync and cache-warming back off
        // with us rather than walking into the same wall.
        const wait = PV_BASE_BACKOFF_MS * (attempt + 1)
        pvBackoffSignal(Math.max(wait, PV_COOLDOWN_MS))
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      if (!res.ok) return null
      return await res.json() as T
    }
    return null
  })
}

const fmt = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Split a span into consecutive <=90 day windows, NEWEST FIRST.
 *
 * Newest first matters: a run that dies partway has still banked the recent
 * history, which is what the dashboard reads.
 */
export function windows(from: Date, to: Date, maxDays = MAX_WINDOW_DAYS): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = []
  let end = new Date(to)
  const floor = new Date(from)
  while (end >= floor) {
    let start = new Date(end.getTime() - (maxDays - 1) * 86400000)
    if (start < floor) start = new Date(floor)
    out.push({ start, end })
    end = new Date(start.getTime() - 86400000)
  }
  return out
}

interface ChartPoint {
  date?: string
  total_sent_count?: number
  total_reply_count?: number
  total_ooo_reply_count?: number
  total_pos_reply_count?: number
  total_new_lead_contacted_count?: number
  total_bounce_count?: number
}
interface StatsHeader {
  total_sent_count?: number
  total_reply_count?: number
  total_ooo_reply_count?: number
  total_pos_reply_count?: number
  total_contacted_count?: number
  total_bounce_count?: number
  recipient_bounce_count?: number
  sender_bounce_count?: number
}
interface BulkRow { email_acc_id: string; email: string; header?: StatsHeader; chart?: ChartPoint[] }

/**
 * Per-day stats for up to 100 mailboxes over one <=90 day window.
 *
 * GET, not POST, and ids go as `email_acc_ids` comma-joined — both cost time to
 * find. Every chart field sums exactly to its header counterpart, so the daily
 * breakdown is trustworthy.
 *
 * The exception is total_contacted_count, which appears ONLY on the header and
 * is slightly higher than the daily new-lead figure (395 vs 394 on one mailbox,
 * 494 vs 489 on another). Every PlusVibe rate divides by it, so the header
 * value is banked separately in mbx_window and rates come from there — summing
 * the daily proxy would drift from what the PlusVibe UI shows.
 */
async function bulkStats(workspaceId: string, ids: string[], start: Date, end: Date): Promise<BulkRow[]> {
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  if (days > MAX_WINDOW_DAYS) throw new Error(`window ${days}d exceeds PlusVibe's ${MAX_WINDOW_DAYS}d limit`)
  const qs = new URLSearchParams({
    workspace_id: workspaceId,
    start_date: fmt(start),
    end_date: fmt(end),
    email_acc_ids: ids.join(','),
    limit: String(CHUNK),
  })
  const d = await pvFetch<{ accounts?: BulkRow[] }>(`/account/email-stats/bulk?${qs}`)
  return d?.accounts ?? []
}

// ── ingest ───────────────────────────────────────────────────────────────────

export interface IngestResult {
  workspaces: number
  mailboxes: number
  dayRows: number
  windowRows: number
  errors: number
}

/**
 * Walk PlusVibe and bank per-day and per-window totals.
 *
 * mode 'backfill' walks each workspace back to its oldest mailbox's creation
 * date — run once. mode 'nightly' refreshes only the current window.
 *
 * Mailboxes come from mailbox_full, which mailbox-sync already keeps current,
 * so this makes no roster calls of its own.
 */
export async function ingest(mode: 'backfill' | 'nightly' = 'nightly', only?: string): Promise<IngestResult> {
  await ensureSchema()
  const stats: IngestResult = { workspaces: 0, mailboxes: 0, dayRows: 0, windowRows: 0, errors: 0 }

  const run = await pool.query<{ id: string }>(
    `INSERT INTO mbx_ingest_run (kind) VALUES ($1) RETURNING id`, [mode],
  )
  const runId = run.rows[0]?.id

  // Long PV batch: tell the shared gate so recurring warmers stand down.
  const endBulk = pvBeginBulk()
  try {
    // mailbox_full has no creation date. warmup_enabled_at is the closest
    // proxy — a mailbox gets warmup turned on when it is provisioned — and it
    // only decides how far BACK a backfill walks. Too early costs a few wasted
    // windows that return zeros; too late loses history, so NULL falls back to
    // a year, which covers the oldest mailbox in the estate (225 days).
    const wsRows = await pool.query<{ workspace_id: string; workspace_name: string; oldest: string | null }>(
      `SELECT m.workspace_id,
              COALESCE(m.workspace_name, m.workspace_id) AS workspace_name,
              MIN(m.warmup_enabled_at)                   AS oldest
         FROM mailbox_full m
        WHERE m.workspace_id IS NOT NULL
          AND m.ignored_at IS NULL
          AND COALESCE(m.workspace_name, '') NOT IN (
                SELECT workspace_name FROM mbx_client_state WHERE state = 'removed')
          AND ($1::text IS NULL OR m.workspace_name = $1)
        GROUP BY m.workspace_id, m.workspace_name`,
      [only ?? null],
    )

    for (const ws of wsRows.rows) {
      const accounts = await pool.query<{ email: string; account_id: string }>(
        `SELECT email, account_id FROM mailbox_full
          WHERE workspace_id = $1 AND account_id IS NOT NULL AND ignored_at IS NULL`,
        [ws.workspace_id],
      )
      if (!accounts.rowCount) continue
      stats.workspaces++
      stats.mailboxes += accounts.rowCount

      // A workspace with no banked history gets backfilled even on a nightly
      // run, whatever the mode.
      //
      // WHY. Nightly only ever looks back 6 days, and backfill was a one-off
      // manual run. Any client onboarded afterwards was therefore invisible
      // forever: measured 2026-09-20, Bruud had 10,282 sends over 90 days in
      // PlusVibe and ZERO rows here. It had stopped sending before the 6-day
      // window opened, so nightly saw nothing and always would. PlusVibe caps
      // ranges at 90 days, so that history was days from being unrecoverable.
      const banked = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM mbx_daily d
           JOIN mailbox_full m ON m.email = d.email
          WHERE m.workspace_id = $1`,
        [ws.workspace_id],
      ).catch(() => null)
      const isNew = Number(banked?.rows[0]?.n ?? 0) === 0

      const from = (mode === 'backfill' || isNew)
        ? new Date(ws.oldest ?? Date.now() - 365 * 86400000)
        : new Date(Date.now() - 6 * 86400000)
      if (isNew && mode === 'nightly') {
        console.log(`[mailbox-health] ${ws.workspace_name}: no history, backfilling`)
      }
      const wins = windows(from, new Date())
      const byId = new Map(accounts.rows.map(a => [a.account_id, a.email.toLowerCase()]))
      const ids = accounts.rows.map(a => a.account_id)

      for (let w = 0; w < wins.length; w++) {
        const win = wins[w]
        for (let i = 0; i < ids.length; i += CHUNK) {
          let rows: BulkRow[]
          try {
            rows = await bulkStats(ws.workspace_id, ids.slice(i, i + CHUNK), win.start, win.end)
          } catch {
            stats.errors++
            continue
          }
          for (const r of rows) {
            const email = (r.email || byId.get(r.email_acc_id) || '').toLowerCase()
            if (!email) continue

            // Daily rows: skip empty days. Their ABSENCE is meaningful — it is
            // how a rest shows up, and how sends_since_rest is derived.
            for (const p of r.chart ?? []) {
              const sent = p.total_sent_count ?? 0
              const ooo = p.total_ooo_reply_count ?? 0
              const replies = p.total_reply_count ?? 0
              const contacted = p.total_new_lead_contacted_count ?? 0
              if (!sent && !ooo && !replies && !contacted) continue
              await pool.query(
                `INSERT INTO mbx_daily (email, date, sent, ooo, replies, positive, contacted, bounce)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (email, date) DO NOTHING`,
                [email, p.date, sent, ooo, replies,
                 p.total_pos_reply_count ?? 0, contacted, p.total_bounce_count ?? 0],
              ).catch(() => { stats.errors++ })
              stats.dayRows++
            }

            // Window headers carry total_contacted_count, the true denominator.
            const h = r.header ?? {}
            await pool.query(
              `INSERT INTO mbx_window (email, start_date, end_date, sent, ooo, replies,
                 positive, contacted, bounce, recipient_bounce, sender_bounce)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (email, start_date, end_date) DO UPDATE SET
                 sent = EXCLUDED.sent, ooo = EXCLUDED.ooo, replies = EXCLUDED.replies,
                 positive = EXCLUDED.positive, contacted = EXCLUDED.contacted,
                 bounce = EXCLUDED.bounce, recipient_bounce = EXCLUDED.recipient_bounce,
                 sender_bounce = EXCLUDED.sender_bounce`,
              [email, fmt(win.start), fmt(win.end), h.total_sent_count ?? 0,
               h.total_ooo_reply_count ?? 0, h.total_reply_count ?? 0,
               h.total_pos_reply_count ?? 0, h.total_contacted_count ?? 0,
               h.total_bounce_count ?? 0, h.recipient_bounce_count ?? 0,
               h.sender_bounce_count ?? 0],
            ).catch(() => { stats.errors++ })
            stats.windowRows++
          }
        }
      }
    }
  } finally {
    endBulk()
  }

  if (runId) {
    await pool.query(
      `UPDATE mbx_ingest_run SET finished_at = now(), workspaces = $2,
              mailboxes = $3, errors = $4 WHERE id = $1`,
      [runId, stats.workspaces, stats.mailboxes, stats.errors],
    ).catch(() => {})
  }
  return stats
}

// ── scheduler ────────────────────────────────────────────────────────────────
// globalThis-flagged, not a module-level boolean: Next instantiates a module
// once per entry bundle, so a module-level flag lets each bundle start its own
// timers. That is the bug that duplicated every log line and 429'd PlusVibe.
const FLAG = '__ottalyMailboxHealthStarted'
let jobRunning = false

/** Has a nightly ingest already succeeded today (UTC)? */
async function ranToday(): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM mbx_ingest_run
      WHERE finished_at IS NOT NULL AND finished_at >= date_trunc('day', now())`,
  ).catch(() => null)
  return Number(r?.rows[0]?.n ?? 0) > 0
}

/**
 * One attempt. Returns false when it deliberately stood down, so the caller
 * knows to come back rather than write the day off.
 *
 * WHY THIS RETRIES. It used to `return` on pvBulkActive() with nothing
 * scheduled but the next 24h interval. mailbox-sync re-arms a 30-MINUTE bulk
 * claim every 30 MINUTES (pv-gate BULK_STALE_MS === mailbox-sync's interval),
 * so that flag is set nearly always and whether the daily tick ever landed in
 * a gap was pure luck. Measured result: no ingest at all after 2026-09-19.
 */
async function tick(mode: 'backfill' | 'nightly', force = false): Promise<boolean> {
  if (jobRunning) return false
  if (!force && await ranToday()) return true
  // Stand down while a bulk job owns the PV queue — mailbox-sync makes ~1,700
  // calls per cycle and there is no point competing with it. The caller retries.
  if (!force && pvBulkActive()) return false
  jobRunning = true
  try {
    const r = await ingest(mode)
    console.log(`[mailbox-health] ${mode}: ${r.mailboxes} mailboxes, `
      + `${r.dayRows} day rows, ${r.errors} errors`)
    return true
  } catch (err) {
    console.error('[mailbox-health] ingest failed:', err)
    return false
  } finally {
    jobRunning = false
  }
}

/** Manual/API entry point. `force` skips the bulk-active and ran-today guards. */
export async function runIngestNow(
  mode: 'backfill' | 'nightly' = 'nightly',
  force = true,
): Promise<boolean> {
  return tick(mode, force)
}

const RETRY_MS = 20 * 60 * 1000

export function startMailboxHealthInterval(): void {
  const g = globalThis as Record<string, unknown>
  if (g[FLAG]) return
  g[FLAG] = true

  // Keep trying until the day's ingest is banked, then idle until tomorrow.
  // A fixed 24h setInterval also drifts with every container restart, which is
  // how runs landed at 14:50 and then 21:05 and then not at all.
  const attempt = () => {
    void tick('nightly').then(done => {
      setTimeout(attempt, done ? sleepUntilTomorrow() : RETRY_MS)
    })
  }
  setTimeout(attempt, 90_000)
  console.log('[mailbox-health] scheduler started (daily, retries every 20m)')
}

/** ms until just after the next UTC midnight, so each day gets one run. */
function sleepUntilTomorrow(): number {
  const now = new Date()
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0))
  return Math.max(60_000, next.getTime() - now.getTime())
}

if (typeof window === 'undefined' && typeof global !== 'undefined') {
  startMailboxHealthInterval()
}
