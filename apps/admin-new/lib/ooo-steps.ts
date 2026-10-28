import pool from './db'
import { pvFetch } from './cache-warming'
import { pvBulkActive } from './pv-gate'

// ── New-lead OOO: which step did each out-of-office answer? ───────────────────
// PlusVibe's OOO RR counts every auto-reply, whatever email it answered. Most
// auto-responders reply ONCE per sender per absence, so the first email draws
// the OOO and follow-ups mostly do not. A day heavy in follow-ups therefore
// shows a low OOO RR that says nothing about deliverability. Measured on Bubble
// 27 Oct: 3.0% on a day where only 174 of 1,098 sends went to new leads.
//
// The useful number is OOO on STEP 1 ÷ new leads contacted. PlusVibe does not
// expose it on the public API (its UI chart comes from a private endpoint), and
// neither the reply nor its stored raw JSON carries the step. So we resolve it:
// for each OOO, read that lead's sent campaign emails and take the step of the
// last one our mailbox sent before the OOO arrived. One PV call per OOO,
// cached here for good.
//
// Which replies count (the label IN list below): PlusVibe's total_ooo_reply_count = label OUT_OF_OFFICE
// plus AUTOMATIC_REPLY. Measured 12-26 Oct: Bubble 305 vs 319 stored, Butterfly
// 724 vs 739 (the gap is day-boundary timezone). OUT_OF_OFFICE alone is half.

// How far back the resolver reaches. 7 days keeps the first fill to ~30 min;
// longer Stats windows show a coverage % for the part before that.
const LOOKBACK_DAYS = Number(process.env.OOO_STEP_LOOKBACK_DAYS ?? 7)
// Per pass. Shares the one PV gate with the warmers. ~350 OOOs arrive a day,
// so 150 every 90s clears a 7-day backlog in under half an hour and then idles.
const BATCH = Number(process.env.OOO_STEP_BATCH ?? 150)
const MAX_ATTEMPTS = 3

let ready = false
async function ensureTable(): Promise<void> {
  if (ready) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ooo_reply_steps (
       pv_email_id  TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL,
       lead_email   TEXT NOT NULL,
       eaccount     TEXT,
       campaign_id  TEXT,
       received_at  TIMESTAMPTZ NOT NULL,
       step         INT,
       state        TEXT NOT NULL,
       attempts     INT NOT NULL DEFAULT 0,
       resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ooo_steps_ws_received
       ON ooo_reply_steps (workspace_id, received_at)`,
  )
  // unibox_replies is ~1.3 GB; without this every pass and every Stats load
  // would scan all of it. The predicate is spelled exactly as in the queries
  // below (a literal IN, not a parameter) or the planner cannot use it.
  // CONCURRENTLY so building it never blocks the two reply writers.
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unibox_ooo_received
       ON unibox_replies (received_at)
       WHERE raw->>'label' IN ('OUT_OF_OFFICE', 'AUTOMATIC_REPLY')`,
  )
  ready = true
}

interface PendingOoo {
  pv_email_id: string
  workspace_id: string
  lead_email: string
  eaccount: string | null
  campaign_id: string | null
  received_at: Date
  attempts: number
}

interface CampaignEmail {
  current_step?: number
  sent_on?: string
  eaccount?: string
  campaign_id?: string
}

// unibox_replies has two writers storing the same email twice (see
// ottaly_unibox_two_writers); raw->>'id' is PlusVibe's id and identical across
// both, so DISTINCT ON it counts each OOO once.
async function pending(limit: number): Promise<PendingOoo[]> {
  const res = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (u.raw->>'id')
              u.raw->>'id'                         AS pv_email_id,
              u.workspace_id,
              COALESCE(u.raw->>'lead', u.lead_email) AS lead_email,
              u.raw->>'eaccount'                   AS eaccount,
              u.raw->>'campaign_id'                AS campaign_id,
              COALESCE((u.raw->>'timestamp_created')::timestamptz, u.received_at) AS received_at,
              COALESCE(s.attempts, 0)              AS attempts
         FROM unibox_replies u
         LEFT JOIN ooo_reply_steps s ON s.pv_email_id = u.raw->>'id'
        WHERE u.raw->>'label' IN ('OUT_OF_OFFICE', 'AUTOMATIC_REPLY')
          AND u.raw->>'id' IS NOT NULL
          AND u.workspace_id IS NOT NULL
          AND u.received_at >= now() - ($1 || ' days')::interval
          AND (s.pv_email_id IS NULL OR (s.state = 'error' AND s.attempts < $2))
        ORDER BY u.raw->>'id'
     ) p
     ORDER BY received_at DESC
     LIMIT $3`,
    [String(LOOKBACK_DAYS), MAX_ATTEMPTS, limit],
  )
  return res.rows as PendingOoo[]
}

// Step of the last email OUR mailbox sent this lead before the OOO landed.
// Matching on the mailbox matters: a lead can sit in two campaigns.
async function resolveOne(o: PendingOoo): Promise<{ step: number | null; state: string }> {
  const emails: CampaignEmail[] = []
  let trail = ''
  // A lead has a handful of emails; three pages is far more than enough.
  for (let page = 0; page < 3; page++) {
    const q =
      `/unibox/campaign-emails?workspace_id=${encodeURIComponent(o.workspace_id)}` +
      `&lead=${encodeURIComponent(o.lead_email)}` +
      (trail ? `&page_trail=${encodeURIComponent(trail)}` : '')
    const body = await pvFetch(q)
    const data: CampaignEmail[] = Array.isArray(body?.data) ? body.data : []
    emails.push(...data)
    trail = body?.page_trail ?? ''
    if (!trail || !data.length) break
  }
  const at = new Date(o.received_at).getTime()
  const mine = emails.filter(
    e =>
      typeof e.current_step === 'number' &&
      e.sent_on &&
      new Date(e.sent_on).getTime() <= at &&
      (!o.eaccount || (e.eaccount ?? '').toLowerCase() === o.eaccount.toLowerCase()),
  )
  if (!mine.length) return { step: null, state: 'nomatch' }
  mine.sort((a, b) => new Date(b.sent_on!).getTime() - new Date(a.sent_on!).getTime())
  return { step: mine[0].current_step!, state: 'done' }
}

let inFlight = false
export async function resolveOooSteps(limit = BATCH): Promise<{ done: number; failed: number }> {
  if (inFlight) return { done: 0, failed: 0 }
  inFlight = true
  let done = 0
  let failed = 0
  try {
    await ensureTable()
    for (const o of await pending(limit)) {
      let step: number | null = null
      let state = 'error'
      try {
        ;({ step, state } = await resolveOne(o))
        done++
      } catch {
        failed++
      }
      await pool.query(
        `INSERT INTO ooo_reply_steps
           (pv_email_id, workspace_id, lead_email, eaccount, campaign_id, received_at, step, state, attempts, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (pv_email_id) DO UPDATE
           SET step = EXCLUDED.step, state = EXCLUDED.state,
               attempts = EXCLUDED.attempts, resolved_at = now()`,
        [o.pv_email_id, o.workspace_id, o.lead_email, o.eaccount, o.campaign_id,
         o.received_at, step, state, o.attempts + 1],
      )
    }
    if (done || failed) console.log(`[ooo-steps] resolved ${done}, failed ${failed}`)
  } catch (err) {
    console.error('[ooo-steps] pass failed:', err)
  } finally {
    inFlight = false
  }
  return { done, failed }
}

export interface NewLeadOoo {
  /** OOOs that answered step 1. */
  step1: number
  /** OOOs with a resolved step (any step, or no match). */
  resolved: number
  /** Every OOO in the window, resolved or not. */
  total: number
}

/**
 * New-lead OOO counts per workspace for an inclusive window, by the day the OOO
 * arrived (Europe/London, matching how the rest of the page buckets days).
 * `resolved < total` means the resolver has not caught up; callers should show
 * the rate as filling rather than as a measured low.
 */
export async function readNewLeadOoo(start: string, end: string): Promise<Map<string, NewLeadOoo>> {
  await ensureTable()
  const res = await pool.query(
    `WITH ooo AS (
       SELECT DISTINCT ON (u.raw->>'id')
              u.raw->>'id' AS id, u.workspace_id
         FROM unibox_replies u
        WHERE u.raw->>'label' IN ('OUT_OF_OFFICE', 'AUTOMATIC_REPLY')
          AND u.raw->>'id' IS NOT NULL
          -- Coarse bound first so the jsonb timestamp is only parsed in-window.
          AND u.received_at >= $1::date - 2 AND u.received_at < $2::date + 3
          AND (COALESCE((u.raw->>'timestamp_created')::timestamptz, u.received_at)
                 AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date
        ORDER BY u.raw->>'id'
     )
     SELECT o.workspace_id,
            COUNT(*)::int                                          AS total,
            COUNT(s.pv_email_id) FILTER (WHERE s.state <> 'error')::int AS resolved,
            COUNT(*) FILTER (WHERE s.step = 1)::int                AS step1
       FROM ooo o
       LEFT JOIN ooo_reply_steps s ON s.pv_email_id = o.id
      GROUP BY o.workspace_id`,
    [start, end],
  )
  const out = new Map<string, NewLeadOoo>()
  for (const r of res.rows as Array<{ workspace_id: string } & NewLeadOoo>) {
    out.set(r.workspace_id, { step1: r.step1, resolved: r.resolved, total: r.total })
  }
  return out
}

// Every 90 seconds, offset from the warmers, yielding to a bulk job like they do.
const FLAG = '__ottalyOooStepsStarted'
export function startOooStepResolver(): void {
  const g = globalThis as Record<string, unknown>
  if (g[FLAG]) return
  g[FLAG] = true
  const INTERVAL_MS = Number(process.env.OOO_STEP_INTERVAL_MS ?? 90 * 1000)
  setTimeout(() => { resolveOooSteps().catch(() => {}) }, 45_000)
  setInterval(() => {
    if (pvBulkActive()) return
    resolveOooSteps().catch(() => {})
  }, INTERVAL_MS)
  console.log('[ooo-steps] resolver started')
}
