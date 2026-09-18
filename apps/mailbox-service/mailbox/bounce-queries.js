/**
 * Bounce read layer.
 *
 * Two rules are enforced here so no caller can get them wrong:
 *
 *   ONLY SENDING FAULTS CHANGE VOLUME. A bounce rate that mixes causes is
 *   meaningless: three mailboxes were paused in a live incident whose only
 *   bounces were dead recipient addresses. Rates are computed per cause, and
 *   the volume-facing one counts sending faults only.
 *
 *   MINIMUM SENDS BEFORE A RATE MEANS ANYTHING. In the same incident, ~15
 *   mailboxes showed "14.3%" from one bounce in seven sends. Below the floor a
 *   mailbox is "insufficient data", never a percentage — the same discipline
 *   the OOO side already uses.
 */

/**
 * Minimum sends before a bounce rate means anything.
 *
 * PlusVibe's own Email Accounts page enforces "needs 10+ emails sent" over a
 * 3-day window before it will show a recipient bounce rate. That is the right
 * instinct, but the number does not transfer: 10 sends in 3 days is a far
 * higher bar than 10 sends in 90 days, and this window is 90 days. The estate
 * averages 26 sends per mailbox per 90 days, about one per 3-day period, so a
 * literal 10 here would rate almost everything.
 *
 * 50 over 90 days keeps 245 mailboxes judgeable and excludes the long tail
 * where a single bounce reads as a double-digit percentage. In the live
 * incident ~15 mailboxes showed "14.3%" from one bounce in seven sends.
 */
const MIN_SENDS = 50;

/**
 * Estate-wide 5.7.233 events in a day before the tenant ceiling is called.
 * Deliberately not per client: the quota is shared, so a per-client rule
 * cannot see it.
 */
const TENANT_ALERT = 10;

/**
 * Recent bounce activity per mailbox, over a short rolling window.
 *
 * PlusVibe's own UI reports over 3 days, and that is the more honest trigger
 * than a single day: the same mailbox that read 50% on one day reads 11.1%
 * across three. A single day turns one bounce into a headline.
 *
 * Counts only — no rate. Attaching a percentage to a 3-day window on an estate
 * averaging ~1 send per mailbox per 3 days would be exactly the small-sample
 * trap the floor exists to prevent. Use this to see what is happening NOW, and
 * byMailbox() for rates.
 */
function recentActivity(db, { days = 3, client = null } = {}) {
  return db.prepare(`
    SELECT b.email,
           m.workspace_name AS client,
           m.daily_limit,
           COUNT(*) AS bounces,
           SUM(CASE WHEN b.action = 'reduce_volume' THEN 1 ELSE 0 END) AS tenant_limit,
           SUM(CASE WHEN b.action IN ('reduce_volume','retire_domain','fix_dns','fix_content')
                    THEN 1 ELSE 0 END) AS sending_faults,
           GROUP_CONCAT(DISTINCT b.cause) AS causes,
           MAX(b.bounced_at) AS last_bounce
    FROM bounce_event b
    JOIN mailbox m ON m.email = b.email
    WHERE b.bounced_at >= date('now', '-' || ? || ' days')
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state='removed')
      AND (? IS NULL OR m.workspace_name = ?)
    GROUP BY b.email
    HAVING sending_faults > 0
    ORDER BY sending_faults DESC, bounces DESC
  `).all(days, client, client);
}

/** Per-mailbox bounce picture, split by cause. */
function byMailbox(db, { days = 14, minSends = MIN_SENDS, client = null } = {}) {
  return db.prepare(`
    SELECT b.email,
           m.workspace_name              AS client,
           m.domain, m.provider, m.daily_limit,
           COUNT(*)                      AS bounces,
           SUM(CASE WHEN b.action = 'reduce_volume' THEN 1 ELSE 0 END) AS tenant_limit,
           SUM(CASE WHEN b.action IN ('reduce_volume','retire_domain','fix_dns','fix_content')
                    THEN 1 ELSE 0 END)   AS sending_faults,
           SUM(CASE WHEN b.action IN ('suppress_lead','none') THEN 1 ELSE 0 END) AS not_our_fault,
           w.sent                        AS sent_90d,
           CASE WHEN w.sent >= ? THEN
             ROUND(SUM(CASE WHEN b.action IN ('reduce_volume','retire_domain','fix_dns','fix_content')
                      THEN 1 ELSE 0 END) * 100.0 / w.sent, 2)
           END                           AS sending_fault_pct,
           MAX(b.bounced_at)             AS last_bounce
    FROM bounce_event b
    JOIN mailbox m ON m.email = b.email
    LEFT JOIN (
      SELECT email, sent FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY email
          ORDER BY end_date DESC, julianday(end_date) - julianday(start_date) DESC) rn
        FROM mailbox_window) WHERE rn = 1
    ) w ON w.email = b.email
    WHERE b.bounced_at >= date('now', '-' || ? || ' days')
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state='removed')
      AND (? IS NULL OR m.workspace_name = ?)
    GROUP BY b.email
    ORDER BY tenant_limit DESC, sending_faults DESC
  `).all(minSends, days, client, client);
}

/**
 * Estate-wide tenant-limit counter, by day.
 *
 * This is the detection that matters and it cannot be per-client. The limit is
 * shared across the whole Microsoft tenant: in the 17-18 Sep incident Shire
 * bounced at 489 sends/day having been clean at 725 the day before, so no
 * per-client threshold could have caught it. Six unrelated clients hit it in
 * the same two days, and it migrated between them as each consumed headroom.
 */
function tenantByDay(db, { days = 30 } = {}) {
  return db.prepare(`
    SELECT substr(bounced_at, 1, 10)     AS date,
           COUNT(*)                      AS tenant_bounces,
           COUNT(DISTINCT workspace)     AS clients_hit,
           COUNT(DISTINCT email)         AS mailboxes_hit
    FROM bounce_event
    WHERE cause = 'tenant_rate_limit'
      AND bounced_at >= date('now', '-' || ? || ' days')
    GROUP BY date
    ORDER BY date DESC
  `).all(days);
}

/** Which clients are involved on the worst day, for context. */
function tenantByClient(db, { days = 7 } = {}) {
  return db.prepare(`
    SELECT workspace                     AS client,
           COUNT(*)                      AS tenant_bounces,
           COUNT(DISTINCT email)         AS mailboxes,
           MIN(substr(bounced_at,1,10))  AS first_seen,
           MAX(substr(bounced_at,1,10))  AS last_seen
    FROM bounce_event
    WHERE cause = 'tenant_rate_limit'
      AND bounced_at >= date('now', '-' || ? || ' days')
    GROUP BY workspace
    ORDER BY tenant_bounces DESC
  `).all(days);
}

/** Every cause seen, with what it implies. Drives the dashboard breakdown. */
function causeSummary(db, { days = 14, client = null } = {}) {
  return db.prepare(`
    SELECT b.cause, b.action,
           COUNT(*)                      AS bounces,
           COUNT(DISTINCT b.email)       AS mailboxes,
           COUNT(DISTINCT b.workspace)   AS clients
    FROM bounce_event b
    WHERE b.bounced_at >= date('now', '-' || ? || ' days')
      AND (? IS NULL OR b.workspace = ?)
    GROUP BY b.cause
    ORDER BY bounces DESC
  `).all(days, client, client);
}

/**
 * Domains with a standing fault: blocklisted, or failing their own DNS policy.
 *
 * For blocklist bounces the domain is read from the message text, because the
 * bounce names the LISTED domain rather than the envelope sender. Measured
 * 2026-09-18, all 91 extractable listings were the sending domain itself, but
 * reading the message keeps that an observation rather than an assumption.
 */
function burnedDomains(db, { days = 30 } = {}) {
  const { listedDomain } = require('./bounce');
  const rows = db.prepare(`
    SELECT b.bounce_msg, b.email, b.workspace AS client, b.cause, b.action,
           b.bounced_at, m.domain AS sending_domain
    FROM bounce_event b
    LEFT JOIN mailbox m ON m.email = b.email
    WHERE b.action IN ('retire_domain', 'fix_dns')
      AND b.bounced_at >= date('now', '-' || ? || ' days')
  `).all(days);

  const agg = new Map();
  for (const r of rows) {
    const domain = (r.cause === 'blocklisted' && listedDomain(r.bounce_msg))
      || r.sending_domain;
    if (!domain) continue;
    const key = `${domain}|${r.cause}`;
    const cur = agg.get(key) || {
      domain, client: r.client, cause: r.cause, action: r.action,
      bounces: 0, last_seen: null, sample: r.bounce_msg,
      is_sending_domain: domain === r.sending_domain,
    };
    cur.bounces++;
    if (!cur.last_seen || r.bounced_at > cur.last_seen) cur.last_seen = r.bounced_at;
    agg.set(key, cur);
  }
  return [...agg.values()].sort((a, b) => b.bounces - a.bounces);
}

/** Unclassified bounces — a recurring one is a missing rule, not a non-event. */
function unclassified(db, { days = 30, limit = 20 } = {}) {
  return db.prepare(`
    SELECT bounce_msg, COUNT(*) AS seen, MAX(bounced_at) AS last_seen
    FROM bounce_event
    WHERE cause = 'unknown' AND bounced_at >= date('now', '-' || ? || ' days')
    GROUP BY substr(bounce_msg, 1, 60)
    ORDER BY seen DESC LIMIT ?
  `).all(days, limit);
}

module.exports = {
  byMailbox, recentActivity, tenantByDay, tenantByClient, causeSummary,
  burnedDomains, unclassified, MIN_SENDS, TENANT_ALERT,
};
