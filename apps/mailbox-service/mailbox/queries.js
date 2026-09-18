/**
 * Read layer for the mailbox dashboard.
 *
 * Two rules from the evidence are enforced here so no caller can get them
 * wrong:
 *
 *   MIN_JUDGE — never judge a mailbox on fewer than 100 contacted. At 25 sends
 *   and a 6% OOO rate, chance alone puts P(zero OOO) at ~21%, which nearly got
 *   16 healthy Northern mailboxes retired. Below the floor a mailbox is
 *   "insufficient data", never 0%.
 *
 *   Rates divide by contacted, never by sends. Sends include follow-ups, so
 *   dividing by them understates every rate against what PlusVibe's UI shows.
 */

const store = require('./db');

const MIN_JUDGE = 100;      // contacted before a mailbox may be called dead
const BURN_THRESHOLD = 350; // working cumulative-send threshold, treat as 300-450
const DEAD_OOO_PCT = 1.5;   // proposed detection threshold

/**
 * SQL fragment excluding removed clients from a query over `mailbox m`.
 *
 * Removed clients keep their history — it is evidence worth having — but must
 * not appear in any view or estate total. Paused clients stay visible: they
 * are still ours and may come back. They are excluded from the ACTION queue
 * instead, since a client who is not sending is not failing.
 */
const NOT_REMOVED = `
  m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state = 'removed')
`;

/**
 * The most recent 90-day window per mailbox, one row each.
 *
 * A mailbox can hold several windows sharing the same end_date: a backfill
 * banks a 90-day window ending today, and that night's run banks a 7-day
 * window ending today too. Selecting on MAX(end_date) alone matches both and
 * silently doubles every count joined against it. Ranking by span picks the
 * widest window for that end date, which is the one the dashboard's 90-day
 * figures are meant to read.
 */
const LATEST_WINDOW = `
  SELECT email, sent, contacted, ooo, replies, positive, bounce
  FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY email
      ORDER BY end_date DESC, julianday(end_date) - julianday(start_date) DESC
    ) AS rn
    FROM mailbox_window
  ) WHERE rn = 1
`;

/** Per-client summary, ranked by urgency. */
function clientSummary(db) {
  return db.prepare(`
    SELECT
      m.workspace_name                                   AS client,
      COUNT(*)                                           AS mailboxes,
      COUNT(DISTINCT m.domain)                           AS domains,
      SUM(CASE WHEN m.status='ERROR' THEN 1 ELSE 0 END)  AS errored,
      ROUND(AVG(c.lifetime_sends))                       AS avg_cum,
      SUM(CASE WHEN c.lifetime_sends >= ${BURN_THRESHOLD} THEN 1 ELSE 0 END) AS past_threshold,
      SUM(c.lifetime_sends)                              AS total_sends,
      SUM(w.sent)                                        AS sent_90d,
      SUM(w.contacted)                                   AS contacted_90d,
      SUM(w.ooo)                                         AS ooo_90d,
      SUM(w.replies)                                     AS replies_90d,
      SUM(w.positive)                                    AS positive_90d,
      ROUND(SUM(w.ooo)   * 100.0 / NULLIF(SUM(w.contacted),0), 2) AS ooo_pct,
      ROUND(SUM(w.replies)*100.0 / NULLIF(SUM(w.contacted),0), 2) AS human_pct,
      CASE WHEN SUM(w.positive) > 0
           THEN ROUND(SUM(w.sent) * 1.0 / SUM(w.positive)) END    AS emails_per_positive
    FROM mailbox m
    LEFT JOIN mailbox_cumulative c ON c.email = m.email
    LEFT JOIN (${LATEST_WINDOW}) w ON w.email = m.email
    WHERE m.retired_at IS NULL AND ${NOT_REMOVED}
    GROUP BY m.workspace_name
    ORDER BY avg_cum DESC
  `).all();
}

/**
 * Runway: months until the average mailbox reaches the burn threshold at the
 * current 90-day send rate.
 *
 * Clients already past the threshold all land on 0 months, which tells you
 * nothing about which of them to act on — and being past it is not itself an
 * emergency. Enviro sits at 1,821 lifetime sends and still returns 9.16% OOO,
 * because what a mailbox has spent since its last rest matters more than what
 * it has spent in total.
 *
 * So urgency is split in two:
 *   - approaching  clients not yet past, ranked by months of runway left
 *   - past         clients already over, ranked by how they are performing
 *
 * A past-threshold client performing well is a rotation candidate, not a fire.
 * A past-threshold client performing badly is the fire.
 */
function withRunway(rows, states = {}) {
  const scored = rows.map((r) => {
    const st = states[r.client]?.state || 'active';
    const perDay = (r.sent_90d || 0) / Math.max(1, r.mailboxes) / 90;
    const remaining = Math.max(0, BURN_THRESHOLD - (r.avg_cum || 0));
    const past = (r.avg_cum || 0) >= BURN_THRESHOLD;
    const runway = past ? 0 : (perDay > 0 ? remaining / perDay / 30 : null);
    return {
      ...r,
      state: st,
      state_note: states[r.client]?.note || null,
      sends_per_mbx_per_day: Number(perDay.toFixed(2)),
      runway_months: runway === null ? null : Number(runway.toFixed(1)),
      over_threshold: past,
      // Lower is worse. Past-threshold clients are ranked by OOO rate, which
      // is what actually says whether the burn is hurting them yet.
      urgency: past ? (r.ooo_pct ?? 0) : null,
    };
  });

  const live = scored.filter((r) => r.state === 'active');
  const paused = scored.filter((r) => r.state !== 'active');

  const approaching = live.filter((r) => !r.over_threshold)
    .sort((a, b) => {
      if (a.runway_months === null) return 1;
      if (b.runway_months === null) return -1;
      return a.runway_months - b.runway_months;
    });
  const past = live.filter((r) => r.over_threshold)
    .sort((a, b) => (a.urgency ?? 0) - (b.urgency ?? 0));

  // Approaching first: they have a deadline. Past-threshold clients are
  // already there and are ranked among themselves by how badly it shows.
  // Paused clients sort last regardless — they are not competing for attention.
  return [...approaching, ...past, ...paused];
}

/** Mailboxes that have sent enough to be judged, with their 90-day rates. */
function judgeable(db, { minContacted = MIN_JUDGE } = {}) {
  return db.prepare(`
    SELECT m.email, m.workspace_name AS client, m.domain, m.provider, m.status,
           m.daily_limit, m.created_at,
           c.lifetime_sends, c.sends_since_rest, c.last_rest_end,
           w.sent, w.contacted, w.ooo, w.replies, w.positive,
           ROUND(w.ooo     * 100.0 / NULLIF(w.contacted,0), 2) AS ooo_pct,
           ROUND(w.replies * 100.0 / NULLIF(w.contacted,0), 2) AS human_pct,
           CAST(julianday('now') - julianday(m.created_at) AS INTEGER) AS age_days
    FROM mailbox m
    JOIN mailbox_cumulative c ON c.email = m.email
    JOIN (${LATEST_WINDOW}) w ON w.email = m.email
    WHERE m.retired_at IS NULL AND ${NOT_REMOVED} AND w.contacted >= ?
    ORDER BY ooo_pct ASC
  `).all(minContacted);
}

/**
 * Mailboxes below the detection threshold. Only ever from judgeable rows.
 *
 * The absolute floor (1.5%) still applies — below that a mailbox is failing on
 * anyone's measure. On top of it, a mailbox is also flagged when it sits far
 * under what its OWN provider achieves, so Microsoft mailboxes are not
 * condemned for being Microsoft and weak Google ones are not excused by a
 * blended average.
 */
function underperforming(db, { threshold = DEAD_OOO_PCT, minContacted = MIN_JUDGE,
                               relative = 0.55 } = {}) {
  const rows = judgeable(db, { minContacted });
  const stats = providerStats(db, { minContacted });
  const blend = (() => {
    const c = rows.reduce((s, r) => s + (r.contacted || 0), 0);
    const o = rows.reduce((s, r) => s + (r.ooo || 0), 0);
    return c ? o / c * 100 : 0;
  })();
  return rows.filter((r) => {
    const v = r.ooo_pct ?? 0;
    if (v < threshold) return true;                       // failing outright
    const base = providerBaseline(stats, r.provider, blend);
    return v < base * relative;                           // failing for its type
  }).map((r) => ({
    ...r,
    provider_baseline: providerBaseline(stats, r.provider, blend),
  }));
}

/**
 * Sends per domain over the last 90 days.
 *
 * This is the estate's strongest measured lever: sends-per-domain correlates
 * with OOO at r = -0.47, far stronger than mailboxes-per-domain at r = -0.10.
 * Nothing currently watches it.
 */
function domainLoad(db) {
  return db.prepare(`
    SELECT m.domain,
           m.workspace_name                AS client,
           COUNT(DISTINCT m.email)         AS mailboxes,
           SUM(w.sent)                     AS sent_90d,
           SUM(w.contacted)                AS contacted_90d,
           SUM(w.ooo)                      AS ooo_90d,
           ROUND(SUM(w.ooo) * 100.0 / NULLIF(SUM(w.contacted),0), 2) AS ooo_pct,
           ROUND(SUM(w.sent) * 1.0 / COUNT(DISTINCT m.email))        AS sent_per_mbx
    FROM mailbox m
    LEFT JOIN (${LATEST_WINDOW}) w ON w.email = m.email
    WHERE m.retired_at IS NULL AND ${NOT_REMOVED} AND m.domain <> ''
    GROUP BY m.domain, m.workspace_name
    ORDER BY sent_90d DESC
  `).all();
}

/**
 * Performance by provider, over the last 90 days.
 *
 * Providers do not perform alike and must not be judged against one blended
 * average. Measured 2026-09-17 across mailboxes with 100+ contacted:
 * Google 6.13% OOO, Microsoft 4.40%. A Microsoft mailbox at 4.5% is normal for
 * its type but reads as weak against the estate blend, and a Google mailbox at
 * 4.5% is genuinely underperforming. Same number, opposite meaning.
 *
 * REGULAR_ACCOUNT is PlusVibe's label for SMTP (Inboxing.com, Aerosend and
 * similar). Those are bulk-provisioned, so they run many mailboxes per domain
 * at a low per-mailbox rate by design.
 */
function providerStats(db, { minContacted = MIN_JUDGE } = {}) {
  const rows = db.prepare(`
    SELECT m.provider,
           COUNT(*)              AS mailboxes,
           SUM(w.sent)           AS sent,
           SUM(w.contacted)      AS contacted,
           SUM(w.ooo)            AS ooo,
           SUM(w.replies)        AS replies,
           SUM(w.positive)       AS positive,
           ROUND(AVG(c.lifetime_sends)) AS avg_lifetime,
           ROUND(SUM(w.ooo)     * 100.0 / NULLIF(SUM(w.contacted),0), 2) AS ooo_pct,
           ROUND(SUM(w.replies) * 100.0 / NULLIF(SUM(w.contacted),0), 2) AS human_pct
    FROM mailbox m
    JOIN mailbox_cumulative c ON c.email = m.email
    JOIN (${LATEST_WINDOW}) w ON w.email = m.email
    WHERE m.retired_at IS NULL AND ${NOT_REMOVED} AND w.contacted >= ?
    GROUP BY m.provider
  `).all(minContacted);
  const out = {};
  for (const r of rows) out[r.provider] = r;
  return out;
}

/**
 * The OOO rate a mailbox should be judged against, given its provider.
 * Falls back to the estate blend for a provider with too little data.
 */
function providerBaseline(stats, provider, fallback) {
  const s = stats[provider];
  if (!s || (s.contacted || 0) < 2000) return fallback;
  return s.ooo_pct;
}

/** Settings state — what Phase 3 will act on. Scoped to one client if given. */
function settingsAudit(db, client = null) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN auto_pause IN ('yes','1') THEN 1 ELSE 0 END) AS auto_pause_on,
      SUM(CASE WHEN COALESCE(rand_pct,0) > 0   THEN 1 ELSE 0 END) AS randomised,
      SUM(CASE WHEN daily_limit = 15 THEN 1 ELSE 0 END)           AS at_limit_15,
      SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END)           AS errored,
      SUM(CASE WHEN provider = 'GOOGLE_WORKSPACE' THEN 1 ELSE 0 END) AS google,
      SUM(CASE WHEN provider = 'MICROSOFT365'     THEN 1 ELSE 0 END) AS microsoft,
      SUM(CASE WHEN provider = 'REGULAR_ACCOUNT'  THEN 1 ELSE 0 END) AS smtp
    FROM mailbox m
    WHERE m.retired_at IS NULL AND ${NOT_REMOVED}
      AND (? IS NULL OR m.workspace_name = ?)
  `).get(client, client);
}

/** Trend by week — is the system working? Scoped to one client if given. */
function estateTrend(db, weeks = 12, client = null) {
  return db.prepare(`
    SELECT strftime('%Y-%W', d.date) AS week,
           MIN(d.date)               AS week_start,
           SUM(d.sent)               AS sent,
           SUM(d.contacted)          AS contacted,
           SUM(d.ooo)                AS ooo,
           SUM(d.replies)            AS replies,
           ROUND(SUM(d.ooo)     * 100.0 / NULLIF(SUM(d.contacted),0), 2) AS ooo_pct,
           ROUND(SUM(d.replies) * 100.0 / NULLIF(SUM(d.contacted),0), 2) AS human_pct,
           COUNT(DISTINCT d.email)   AS active_mailboxes
    FROM mailbox_daily d
    JOIN mailbox m ON m.email = d.email
    WHERE ${NOT_REMOVED} AND (? IS NULL OR m.workspace_name = ?)
    GROUP BY week ORDER BY week DESC LIMIT ?
  `).all(client, client, weeks);
}

/**
 * Ingest status, so a silently failing nightly job is visible.
 *
 * Reports the last run that actually FINISHED — a run killed partway leaves a
 * row with finished_at null, and showing that as "the last ingest" would read
 * as "no data" while the store is in fact fully populated. Any unfinished run
 * is reported separately as `stalled` rather than hidden.
 */
function lastRun(db) {
  const done = db.prepare(`
    SELECT * FROM ingest_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1
  `).get();
  const stalled = db.prepare(`
    SELECT COUNT(*) AS n FROM ingest_run WHERE finished_at IS NULL
  `).get().n;
  return done ? { ...done, stalled } : { stalled };
}

module.exports = {
  MIN_JUDGE, BURN_THRESHOLD, DEAD_OOO_PCT,
  clientSummary, withRunway, judgeable, underperforming,
  domainLoad, settingsAudit, estateTrend, lastRun,
  providerStats, providerBaseline, open: store.open,
};
