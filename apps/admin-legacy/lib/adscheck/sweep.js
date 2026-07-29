// Full-database sweep: queue every distinct company domain in `contacts`.
//
// The point of sweeping by DOMAIN rather than by contact is that one check
// answers every contact at that company — worker.stampContacts writes the
// result to all of them, including contacts imported later. ~600k contacts
// collapse to a much smaller set of companies.
//
// Built entirely in SQL. At this scale, pulling the domain list into Node and
// POSTing it back would be pointless memory churn.

const crypto = require('crypto');
const { DOMAIN_NORM_SQL } = require('./schema');

// Only sweep UK companies. `company_country` is the authority (Apollo fills it
// as "United Kingdom"), with the UK TLDs as a second route in — a .co.uk domain
// is UK regardless of what the country column says, and country is often blank.
// Anything else is skipped rather than guessed at.
const UK_FILTER = `(
     company_country ILIKE '%united kingdom%'
  OR company_country ILIKE '%great britain%'
  OR UPPER(TRIM(COALESCE(company_country,''))) IN ('UK','GB','GBR','ENGLAND','SCOTLAND','WALES','NORTHERN IRELAND')
  OR country ILIKE '%united kingdom%'
  OR UPPER(TRIM(COALESCE(country,''))) IN ('UK','GB','GBR','ENGLAND','SCOTLAND','WALES','NORTHERN IRELAND')
  OR ${DOMAIN_NORM_SQL} ~ '\\.uk$'
)`;

// A plausible hostname. Mirrors normalizeDomain()'s final test.
const VALID_DOMAIN = `s.domain ~ '^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$'`;

function scopeSql(ukOnly) {
  return `company_domain IS NOT NULL AND company_domain <> ''` + (ukOnly ? ` AND ${UK_FILTER}` : '');
}

/**
 * How many domains a sweep would queue right now.
 * `staleDays` = re-check a domain only if it hasn't been checked in that long;
 * 0 means re-check everything.
 */
async function previewSweep(db, { ukOnly = true, staleDays = 30 } = {}) {
  // Two COUNT(DISTINCT)s in one pass, rather than GROUP BY + bool_or over a
  // subquery — same answer, one scan, and it stays inside the pool's 45s
  // statement_timeout on a ~600k-row contacts table.
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT d)::int AS total_domains,
            COUNT(DISTINCT d) FILTER (
              WHERE $1::int <= 0 OR ads_checked_at IS NULL
                 OR ads_checked_at < now() - ($1::int * interval '1 day'))::int AS to_check
       FROM (
         SELECT ${DOMAIN_NORM_SQL} AS d, ads_checked_at
           FROM contacts
          WHERE ${scopeSql(ukOnly)}
       ) s
      WHERE d ~ '^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$'`, [staleDays]);
  return rows[0];
}

/**
 * Create a sweep batch. Returns { id, total, cached } — total 0 means
 * everything is already answered and nothing was queued.
 */
async function createSweep(db, { name, region = 'anywhere', ukOnly = true, staleDays = 30, cacheTtlDays = 7, auto = false } = {}) {
  const id = crypto.randomUUID();
  const label = (name || '').trim()
    || `${auto ? 'Auto sweep' : 'Full sweep'}${ukOnly ? ' (UK)' : ''} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  // This insert reads ~600k contacts, DISTINCTs them down to ~190k domains and
  // writes all of them — comfortably past the pool's 45s statement_timeout,
  // which cancelled it mid-flight and left an empty batch behind. Take a
  // DEDICATED connection so a longer timeout actually applies to the right
  // session: with the shared pool, `SET` and the INSERT can land on different
  // connections and the setting silently does nothing.
  const client = db.pool ? await db.pool.connect() : null;
  const q = client ? (t, p) => client.query(t, p) : (t, p) => db.query(t, p);

  try {
  if (client) await q(`SET statement_timeout = '900s'`);

  await q(
    `INSERT INTO ads_batches (id, name, region, total, status) VALUES ($1,$2,$3,0,'running')`,
    [id, label, region]);

  // Pre-fill from the cross-batch cache where it's still fresh, so a re-run
  // doesn't re-scrape what another batch already answered.
  const { rowCount } = await q(
    `INSERT INTO ads_jobs (batch_id, domain, status, runs_ads, ad_count, is_estimate, advertisers, updated_at)
     SELECT $1, s.domain,
            CASE WHEN dc.domain IS NOT NULL THEN 'done' ELSE 'queued' END,
            dc.runs_ads, dc.ad_count, dc.is_estimate, dc.advertisers, now()
       FROM (
         SELECT DISTINCT ${DOMAIN_NORM_SQL} AS domain
           FROM contacts
          WHERE ${scopeSql(ukOnly)}
            AND ($2::int <= 0 OR ads_checked_at IS NULL
                 OR ads_checked_at < now() - ($2::int * interval '1 day'))
       ) s
       LEFT JOIN ads_domain_cache dc
              ON dc.domain = s.domain AND dc.region = $3
             AND $4::int > 0 AND dc.checked_at > now() - ($4::int * interval '1 day')
      WHERE ${VALID_DOMAIN}
      ON CONFLICT (batch_id, domain) DO NOTHING`,
    [id, staleDays, region, cacheTtlDays]);

    await q(`UPDATE ads_batches SET total=$2 WHERE id=$1`, [id, rowCount]);

    if (!rowCount) {
      // Nothing to do — drop the batch entirely rather than leaving an empty
      // shell in the list. Continuous mode would otherwise create one of these
      // every few minutes forever.
      await q(`DELETE FROM ads_batches WHERE id=$1`, [id]);
      return { id: null, total: 0, cached: 0 };
    }
    const c = await q(
      `SELECT COUNT(*) FILTER (WHERE status='done')::int AS cached FROM ads_jobs WHERE batch_id=$1`, [id]);
    // A fully-cached sweep has nothing to drain.
    if (c.rows[0].cached === rowCount) {
      await q(`UPDATE ads_batches SET status='done' WHERE id=$1`, [id]);
    }
    return { id, total: rowCount, cached: c.rows[0].cached };
  } catch (err) {
    // A failed sweep must not leave a 0/1 phantom batch behind (a cancelled
    // statement did exactly that). Clean up before rethrowing.
    await db.query(`DELETE FROM ads_batches WHERE id=$1`, [id]).catch(() => {});
    throw err;
  } finally {
    if (client) {
      await client.query(`SET statement_timeout = DEFAULT`).catch(() => {});
      client.release();
    }
  }
}

/**
 * Remove sweep batches that were left empty by a failed/cancelled insert.
 * Safe: only touches batches that have no jobs at all.
 */
async function cleanupEmptyBatches(db) {
  const r = await db.query(
    `DELETE FROM ads_batches b
      WHERE NOT EXISTS (SELECT 1 FROM ads_jobs j WHERE j.batch_id = b.id)
        AND b.created_at < now() - interval '2 minutes'`);
  return r.rowCount;
}

// ── settings (auto-sweep on/off) ───────────────────────────
async function getSetting(db, key, dflt = null) {
  try {
    const { rows } = await db.query(`SELECT value FROM ads_settings WHERE key=$1`, [key]);
    return rows.length ? rows[0].value : dflt;
  } catch { return dflt; }
}
async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO ads_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, String(value)]);
}

module.exports = { createSweep, previewSweep, cleanupEmptyBatches, getSetting, setSetting, UK_FILTER };
