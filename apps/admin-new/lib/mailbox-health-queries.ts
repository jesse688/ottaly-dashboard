/**
 * Mailbox health: the read layer.
 *
 * Two rules are enforced here so no caller can get them wrong:
 *
 *   NEVER JUDGE A MAILBOX UNDER 100 CONTACTED. At 25 sends and a 6% OOO rate,
 *   chance alone puts P(zero OOO) at ~21% — that nearly retired 16 healthy
 *   Northern mailboxes. Below the floor a mailbox is "insufficient data",
 *   never 0%.
 *
 *   RATES DIVIDE BY CONTACTED, NEVER BY SENDS. Sends include follow-ups, so
 *   dividing by them understates every rate against what PlusVibe's own UI
 *   shows. The denominator lives on the window header (mbx_window.contacted).
 */

import { q } from './query'
import { BURN_THRESHOLD, MIN_JUDGE } from './mailbox-health'

/**
 * The widest recent window per mailbox, one row each. Every "90d" figure on
 * the page reads from here.
 *
 * TWO bugs have been fixed in this ranking, and they pull in opposite
 * directions. Keep both in mind before touching the ORDER BY.
 *
 *   1. DOUBLE-COUNTING. A mailbox can hold several windows sharing an
 *      end_date: a backfill banks 90 days ending today, and that night's run
 *      banks 7 days ending today too. MAX(end_date) alone matches both and
 *      silently DOUBLES every count joined against it — Lending Team read 174
 *      mailboxes against an actual 87.
 *
 *   2. UNDER-REPORTING (worse, and what SPAN_FLOOR fixes). Ranking by
 *      end_date FIRST means a nightly 6-day window, which always has the
 *      newest end_date, beats the backfill's 90-day window every time.
 *      Measured 2026-09-20: 1,608 of 1,656 mailboxes were serving a 6-day
 *      window as their "90d" figure. Consequences, both silent:
 *        - judgeable() filters contacted >= 100; a 6-day window rarely gets
 *          there, so the mailbox list returned ZERO rows against a true 377.
 *        - rankByUrgency divides sent_90d by 90, so burn read ~13x low and
 *          runway ~13x high. Nothing ever tripped the <3 month warning and
 *          the buy calendar stayed empty.
 *
 * So: prefer a window that is actually long enough to mean "90d"
 * (SPAN_FLOOR), and only among those take the most recent. The final
 * (end_date - start_date) DESC still settles ties within one end_date, which
 * is what keeps bug 1 fixed.
 *
 * The COALESCE fallback matters: a brand-new client has only ever had short
 * windows banked, and showing it with no numbers at all is worse than showing
 * it with narrow ones. is_full_window tells the caller which it got.
 */
const SPAN_FLOOR = 60

const LATEST_WINDOW = `
  SELECT email, sent, contacted, ooo, replies, positive, bounce,
         recipient_bounce, sender_bounce, span_days,
         (span_days >= ${SPAN_FLOOR}) AS is_full_window
    FROM (
      SELECT w.*,
             (w.end_date - w.start_date) AS span_days,
             ROW_NUMBER() OVER (
               PARTITION BY email
               ORDER BY ((w.end_date - w.start_date) >= ${SPAN_FLOOR}) DESC,
                        end_date DESC,
                        (w.end_date - w.start_date) DESC
             ) AS rn
        FROM mbx_window w
    ) ranked
   WHERE rn = 1
`

/** Removed clients keep their history but appear nowhere. */
const NOT_REMOVED = `
  COALESCE(m.workspace_name, '') NOT IN (
    SELECT workspace_name FROM mbx_client_state WHERE state = 'removed')
`

export interface ClientRow {
  client: string
  mailboxes: number
  domains: number
  errored: number
  avg_cum: number
  past_threshold: number
  sent_90d: number
  contacted_90d: number
  /** Real days the 90d figures cover. Rates and burn divide by this. */
  window_days: number
  /** Mailboxes whose window is genuinely wide enough to call "90d". */
  full_window_mbx: number
  ooo_90d: number
  replies_90d: number
  positive_90d: number
  ooo_pct: number | null
  human_pct: number | null
  emails_per_positive: number | null
  state: string
}

/** Per-client summary. Cumulative sends come from banked daily rows. */
export async function clientSummary(client?: string): Promise<ClientRow[]> {
  const rows = await q<Record<string, string | null>>(
    `WITH cum AS (
       SELECT email, SUM(sent)::bigint AS lifetime_sends
         FROM mbx_daily GROUP BY email
     ), win AS (${LATEST_WINDOW})
     SELECT COALESCE(m.workspace_name, m.workspace_id)        AS client,
            COUNT(*)                                          AS mailboxes,
            COUNT(DISTINCT m.domain)                          AS domains,
            COUNT(*) FILTER (WHERE m.status = 'ERROR')        AS errored,
            ROUND(AVG(COALESCE(cum.lifetime_sends, 0)))       AS avg_cum,
            COUNT(*) FILTER (WHERE COALESCE(cum.lifetime_sends,0) >= ${BURN_THRESHOLD}) AS past_threshold,
            COALESCE(SUM(win.sent), 0)                        AS sent_90d,
            COALESCE(SUM(win.contacted), 0)                   AS contacted_90d,
            -- The real span the sent_90d figure covers. Burn rate divides by
            -- this, never by a hardcoded 90: a client whose mailboxes have
            -- only ever banked short windows would otherwise read ~13x low.
            COALESCE(ROUND(AVG(win.span_days + 1)), 90)       AS window_days,
            COUNT(*) FILTER (WHERE win.is_full_window)        AS full_window_mbx,
            COALESCE(SUM(win.ooo), 0)                         AS ooo_90d,
            COALESCE(SUM(win.replies), 0)                     AS replies_90d,
            COALESCE(SUM(win.positive), 0)                    AS positive_90d,
            ROUND(SUM(win.ooo)     * 100.0 / NULLIF(SUM(win.contacted), 0), 2) AS ooo_pct,
            ROUND(SUM(win.replies) * 100.0 / NULLIF(SUM(win.contacted), 0), 2) AS human_pct,
            CASE WHEN SUM(win.positive) > 0
                 THEN ROUND(SUM(win.sent) * 1.0 / SUM(win.positive)) END       AS emails_per_positive,
            COALESCE(cs.state, 'active')                      AS state
       FROM mailbox_full m
       LEFT JOIN cum ON cum.email = m.email
       LEFT JOIN win ON win.email = m.email
       LEFT JOIN mbx_client_state cs ON cs.workspace_name = m.workspace_name
      WHERE m.ignored_at IS NULL AND ${NOT_REMOVED}
        AND ($1::text IS NULL OR m.workspace_name = $1)
      GROUP BY client, cs.state
      ORDER BY avg_cum DESC NULLS LAST`,
    [client ?? null],
    { tag: 'mailbox-health:clients' },
  )
  // pg returns bigint and numeric as strings.
  return rows.map(r => ({
    client: String(r.client),
    mailboxes: Number(r.mailboxes),
    domains: Number(r.domains),
    errored: Number(r.errored),
    avg_cum: Number(r.avg_cum ?? 0),
    past_threshold: Number(r.past_threshold),
    sent_90d: Number(r.sent_90d),
    contacted_90d: Number(r.contacted_90d),
    window_days: Number(r.window_days ?? 90),
    full_window_mbx: Number(r.full_window_mbx ?? 0),
    ooo_90d: Number(r.ooo_90d),
    replies_90d: Number(r.replies_90d),
    positive_90d: Number(r.positive_90d),
    ooo_pct: r.ooo_pct === null ? null : Number(r.ooo_pct),
    human_pct: r.human_pct === null ? null : Number(r.human_pct),
    emails_per_positive: r.emails_per_positive === null ? null : Number(r.emails_per_positive),
    state: String(r.state),
  }))
}

export interface RankedClient extends ClientRow {
  sends_per_mbx_per_day: number
  runway_months: number | null
  over_threshold: boolean
}

/**
 * Runway: months until the average mailbox reaches the burn threshold at its
 * current rate.
 *
 * Clients already past it all land on 0, which says nothing about which to act
 * on — and being past it is NOT itself an emergency. Enviro sits at 1,821
 * lifetime sends and still returns 9.16% OOO, because what a mailbox has spent
 * since its last rest matters more than its lifetime total.
 *
 * So urgency splits in two: clients with a deadline, ranked by how little
 * runway is left; then clients already past, ranked by how badly it shows.
 * Paused clients sort last — they are not competing for attention.
 */
export function rankByUrgency(rows: ClientRow[]): RankedClient[] {
  const scored = rows.map(r => {
    // Divide by the window's REAL span, not 90. Reading a 7-day window as if
    // it were 90 days understated burn ~13x and pushed runway far enough out
    // that no client ever tripped the <3 month warning.
    const days = Math.max(1, r.window_days || 90)
    const perDay = (r.sent_90d || 0) / Math.max(1, r.mailboxes) / days
    const past = (r.avg_cum || 0) >= BURN_THRESHOLD
    const remaining = Math.max(0, BURN_THRESHOLD - (r.avg_cum || 0))
    const runway = past ? 0 : (perDay > 0 ? remaining / perDay / 30 : null)
    return {
      ...r,
      sends_per_mbx_per_day: Number(perDay.toFixed(2)),
      runway_months: runway === null ? null : Number(runway.toFixed(1)),
      over_threshold: past,
    }
  })
  const live = scored.filter(r => r.state === 'active')
  const rest = scored.filter(r => r.state !== 'active')
  const approaching = live.filter(r => !r.over_threshold).sort((a, b) => {
    if (a.runway_months === null) return 1
    if (b.runway_months === null) return -1
    return a.runway_months - b.runway_months
  })
  const past = live.filter(r => r.over_threshold)
    .sort((a, b) => (a.ooo_pct ?? 0) - (b.ooo_pct ?? 0))
  return [...approaching, ...past, ...rest]
}

export interface MailboxRow {
  email: string
  client: string
  domain: string | null
  provider: string | null
  status: string | null
  daily_limit: number | null
  lifetime_sends: number
  sends_since_rest: number
  sent: number
  contacted: number
  ooo: number
  replies: number
  ooo_pct: number | null
  human_pct: number | null
  flagged_reason: string | null
  paused_at: string | null
}

/**
 * Mailboxes with enough contacted to judge.
 *
 * sends_since_rest counts sends since the last gap of 7+ days with no sending.
 * It is probably the number that really matters: Accrue has sent 1,327 lifetime
 * but rests half its life and is still improving, while Hayes died at 369
 * sending continuously.
 */
export async function judgeable(opts: { client?: string; minContacted?: number } = {}): Promise<MailboxRow[]> {
  const min = opts.minContacted ?? MIN_JUDGE
  const rows = await q<Record<string, string | null>>(
    `WITH cum AS (
       SELECT email, SUM(sent)::bigint AS lifetime_sends FROM mbx_daily GROUP BY email
     ), gaps AS (
       -- A rest is a gap of 7+ days between sending days. Sum only what has
       -- been sent since the most recent one.
       SELECT email, date, sent,
              date - LAG(date) OVER (PARTITION BY email ORDER BY date) AS gap_days
         FROM mbx_daily WHERE sent > 0
     ), rested AS (
       -- Most recent rest per mailbox, as a window function over the whole
       -- partition. This replaced a LEFT JOIN LATERAL that re-scanned gaps
       -- once PER ROW: across ~71k sending days that took over 30 seconds and
       -- blew the 8s statement timeout, so /api/mailbox-health, /mailboxes
       -- and /actions all returned 500 while the page itself rendered fine.
       --
       -- MUST be OVER (PARTITION BY email) with NO frame clause. A running
       -- frame (ROWS UNBOUNDED PRECEDING) leaves last_rest NULL for rows
       -- BEFORE the rest, which the IS NULL branch below then lets through --
       -- silently counting pre-rest sends. Verified against the old query on
       -- 200 mailboxes: identical, and 1.6s instead of 30s+.
       SELECT email, date, sent,
              MAX(CASE WHEN gap_days >= 7 THEN date END)
                OVER (PARTITION BY email) AS last_rest
         FROM gaps
     ), since_rest AS (
       SELECT email, SUM(sent)::bigint AS sends_since_rest
         FROM rested
        WHERE last_rest IS NULL OR date >= last_rest
        GROUP BY email
     ), win AS (${LATEST_WINDOW})
     SELECT m.email,
            COALESCE(m.workspace_name, m.workspace_id) AS client,
            m.domain, m.provider, m.status, m.daily_limit,
            m.flagged_reason, m.paused_at,
            COALESCE(cum.lifetime_sends, 0)   AS lifetime_sends,
            COALESCE(sr.sends_since_rest, 0)  AS sends_since_rest,
            win.sent, win.contacted, win.ooo, win.replies,
            ROUND(win.ooo     * 100.0 / NULLIF(win.contacted, 0), 2) AS ooo_pct,
            ROUND(win.replies * 100.0 / NULLIF(win.contacted, 0), 2) AS human_pct
       FROM mailbox_full m
       JOIN win ON win.email = m.email
       LEFT JOIN cum ON cum.email = m.email
       LEFT JOIN since_rest sr ON sr.email = m.email
      WHERE m.ignored_at IS NULL AND ${NOT_REMOVED}
        AND win.contacted >= $1
        AND ($2::text IS NULL OR m.workspace_name = $2)
      ORDER BY ooo_pct ASC NULLS LAST`,
    [min, opts.client ?? null],
    { tag: 'mailbox-health:judgeable' },
  )
  return rows.map(r => ({
    email: String(r.email),
    client: String(r.client),
    domain: r.domain,
    provider: r.provider,
    status: r.status,
    daily_limit: r.daily_limit === null ? null : Number(r.daily_limit),
    lifetime_sends: Number(r.lifetime_sends),
    sends_since_rest: Number(r.sends_since_rest),
    sent: Number(r.sent),
    contacted: Number(r.contacted),
    ooo: Number(r.ooo),
    replies: Number(r.replies),
    ooo_pct: r.ooo_pct === null ? null : Number(r.ooo_pct),
    human_pct: r.human_pct === null ? null : Number(r.human_pct),
    flagged_reason: r.flagged_reason,
    paused_at: r.paused_at,
  }))
}

/**
 * Baselines per provider.
 *
 * Providers do not perform alike and must not be judged against one blended
 * average. Measured 2026-09-17 on mailboxes with 100+ contacted: Google 6.13%
 * OOO, Microsoft 4.40%. A Microsoft mailbox at 4.5% is normal for its type; a
 * Google mailbox at 4.5% is underperforming. Same number, opposite meaning.
 */
export async function providerStats(minContacted = MIN_JUDGE) {
  const rows = await q<Record<string, string | null>>(
    `WITH win AS (${LATEST_WINDOW})
     SELECT m.provider,
            COUNT(*)                AS mailboxes,
            SUM(win.sent)           AS sent,
            SUM(win.contacted)      AS contacted,
            SUM(win.ooo)            AS ooo,
            SUM(win.replies)        AS replies,
            SUM(win.positive)       AS positive,
            ROUND(SUM(win.ooo)     * 100.0 / NULLIF(SUM(win.contacted), 0), 2) AS ooo_pct,
            ROUND(SUM(win.replies) * 100.0 / NULLIF(SUM(win.contacted), 0), 2) AS human_pct
       FROM mailbox_full m
       JOIN win ON win.email = m.email
      WHERE m.ignored_at IS NULL AND ${NOT_REMOVED} AND win.contacted >= $1
      GROUP BY m.provider`,
    [minContacted],
    { tag: 'mailbox-health:providers' },
  )
  const out: Record<string, { mailboxes: number; ooo_pct: number | null; human_pct: number | null; positive: number }> = {}
  for (const r of rows) {
    out[String(r.provider)] = {
      mailboxes: Number(r.mailboxes),
      ooo_pct: r.ooo_pct === null ? null : Number(r.ooo_pct),
      human_pct: r.human_pct === null ? null : Number(r.human_pct),
      positive: Number(r.positive ?? 0),
    }
  }
  return out
}

/**
 * Sends per domain over the latest window.
 *
 * The estate's strongest measured lever: sends-per-domain correlates with OOO
 * at r = -0.47, against mailboxes-per-domain at r = -0.10. Judge a domain on
 * its VOLUME, never its headcount — bulk-provisioned domains (Inboxing.com and
 * similar) deliberately run 20-99 mailboxes at a low rate each, and that is the
 * product working as sold, not a misconfiguration.
 */
export async function domainLoad(client?: string) {
  const rows = await q<Record<string, string | null>>(
    `WITH win AS (${LATEST_WINDOW})
     SELECT m.domain,
            COALESCE(m.workspace_name, m.workspace_id) AS client,
            COUNT(DISTINCT m.email)  AS mailboxes,
            COALESCE(SUM(win.sent), 0)      AS sent_90d,
            COALESCE(SUM(win.contacted), 0) AS contacted_90d,
            COALESCE(SUM(win.ooo), 0)       AS ooo_90d,
            ROUND(SUM(win.ooo) * 100.0 / NULLIF(SUM(win.contacted), 0), 2) AS ooo_pct,
            ROUND(COALESCE(SUM(win.sent), 0) * 1.0 / COUNT(DISTINCT m.email)) AS sent_per_mbx
       FROM mailbox_full m
       LEFT JOIN win ON win.email = m.email
      WHERE m.ignored_at IS NULL AND ${NOT_REMOVED}
        AND COALESCE(m.domain, '') <> ''
        AND ($1::text IS NULL OR m.workspace_name = $1)
      GROUP BY m.domain, client
      ORDER BY sent_90d DESC`,
    [client ?? null],
    { tag: 'mailbox-health:domains' },
  )
  return rows.map(r => ({
    domain: String(r.domain),
    client: String(r.client),
    mailboxes: Number(r.mailboxes),
    sent_90d: Number(r.sent_90d),
    contacted_90d: Number(r.contacted_90d),
    ooo_90d: Number(r.ooo_90d),
    ooo_pct: r.ooo_pct === null ? null : Number(r.ooo_pct),
    sent_per_mbx: Number(r.sent_per_mbx ?? 0),
  }))
}

/** Estate settings state — what an auto-apply pass would act on. */
export async function settingsAudit(client?: string) {
  const rows = await q<Record<string, string>>(
    `SELECT COUNT(*)                                                    AS total,
            COUNT(*) FILTER (WHERE m.status = 'ERROR')                  AS errored,
            COUNT(*) FILTER (WHERE m.daily_limit = 0)                   AS at_zero,
            COUNT(*) FILTER (WHERE m.daily_limit = 15)                  AS at_limit_15,
            COUNT(*) FILTER (WHERE m.provider ILIKE '%google%')          AS google,
            COUNT(*) FILTER (WHERE m.provider ILIKE '%microsoft%')       AS microsoft,
            COUNT(DISTINCT m.domain)                                    AS domains
       FROM mailbox_full m
      WHERE m.ignored_at IS NULL AND ${NOT_REMOVED}
        AND ($1::text IS NULL OR m.workspace_name = $1)`,
    [client ?? null],
    { tag: 'mailbox-health:settings' },
  )
  const r = rows[0] ?? {}
  return {
    total: Number(r.total ?? 0),
    errored: Number(r.errored ?? 0),
    at_zero: Number(r.at_zero ?? 0),
    at_limit_15: Number(r.at_limit_15 ?? 0),
    google: Number(r.google ?? 0),
    microsoft: Number(r.microsoft ?? 0),
    domains: Number(r.domains ?? 0),
  }
}

/** Weekly trend — is the estate getting better or worse? */
export async function estateTrend(weeks = 12, client?: string) {
  const rows = await q<Record<string, string | null>>(
    `SELECT to_char(date_trunc('week', d.date), 'YYYY-MM-DD') AS week_start,
            SUM(d.sent)      AS sent,
            SUM(d.contacted) AS contacted,
            SUM(d.ooo)       AS ooo,
            SUM(d.replies)   AS replies,
            ROUND(SUM(d.ooo)     * 100.0 / NULLIF(SUM(d.contacted), 0), 2) AS ooo_pct,
            ROUND(SUM(d.replies) * 100.0 / NULLIF(SUM(d.contacted), 0), 2) AS human_pct,
            COUNT(DISTINCT d.email) AS active_mailboxes
       FROM mbx_daily d
       JOIN mailbox_full m ON m.email = d.email
      WHERE ${NOT_REMOVED}
        AND ($2::text IS NULL OR m.workspace_name = $2)
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $1`,
    [weeks, client ?? null],
    { tag: 'mailbox-health:trend' },
  )
  return rows.map(r => ({
    week_start: String(r.week_start),
    sent: Number(r.sent),
    contacted: Number(r.contacted),
    ooo: Number(r.ooo),
    replies: Number(r.replies),
    ooo_pct: r.ooo_pct === null ? null : Number(r.ooo_pct),
    human_pct: r.human_pct === null ? null : Number(r.human_pct),
    active_mailboxes: Number(r.active_mailboxes),
  }))
}

/** Last FINISHED ingest. A run killed partway leaves finished_at null, and
 *  reporting that as "the last ingest" reads as "no data" while the store is
 *  in fact fully populated. */
export async function lastRun() {
  const done = await q<Record<string, string | null>>(
    `SELECT kind, finished_at, mailboxes, errors
       FROM mbx_ingest_run WHERE finished_at IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [], { tag: 'mailbox-health:lastrun' },
  )
  const stalled = await q<{ n: string }>(
    `SELECT COUNT(*) AS n FROM mbx_ingest_run WHERE finished_at IS NULL`,
    [], { tag: 'mailbox-health:stalled' },
  )
  const r = done[0]
  return {
    kind: r?.kind ?? null,
    finished_at: r?.finished_at ?? null,
    mailboxes: r?.mailboxes === undefined || r.mailboxes === null ? null : Number(r.mailboxes),
    errors: r?.errors === undefined || r.errors === null ? null : Number(r.errors),
    stalled: Number(stalled[0]?.n ?? 0),
  }
}
