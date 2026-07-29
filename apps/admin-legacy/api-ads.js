// Google Ads Transparency checker API for admin-legacy.
//
//   POST   /api/ads/batches                  { name?, region?, domains?:[], text? } -> { id, total, cached }
//   GET    /api/ads/batches                  list + progress counts
//   GET    /api/ads/batches/:id              batch + { queued, running, done, error, yes, no }
//   GET    /api/ads/batches/:id/jobs         ?status=&search=&sort=&limit=&offset=
//   GET    /api/ads/batches/:id/export.csv   streamed CSV
//   POST   /api/ads/batches/:id/pause|resume|retry-errors
//   DELETE /api/ads/batches/:id
//   GET    /api/ads/health                   worker heartbeats + queue depth
//
// Mounted in server.js via: app.use('/api/ads', require('./api-ads')(getWorker))
// The worker itself lives in lib/adscheck/worker.js and runs in this process.

const express = require('express');
const crypto = require('crypto');
const { ensureSchema, DOMAIN_NORM_SQL } = require('./lib/adscheck/schema');
const { startSweepDetached, previewSweep, getSetting, setSetting } = require('./lib/adscheck/sweep');
const { normalizeList, parseDomainText } = require('./lib/adscheck/normalize');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION_RE = /^[A-Za-z-]{2,16}$/;
const MAX_DOMAINS = 50000;

const SORTS = {
  domain: 'domain ASC',
  count_desc: 'ad_count DESC NULLS LAST, domain ASC',
  count_asc: 'ad_count ASC NULLS LAST, domain ASC',
  recent: 'updated_at DESC',
  id: 'id ASC',
};

module.exports = function adsAPI(getWorker) {
  const router = express.Router();

  // Every route needs the pool + the ads_* tables; fail loudly if there's no DB.
  router.use(async (req, res, next) => {
    const db = req.app.locals.pgDb;
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await ensureSchema(db);
      req.db = db;
      next();
    } catch (err) {
      res.status(500).json({ error: 'Schema init failed: ' + err.message });
    }
  });

  const badId = (id) => !UUID_RE.test(String(id || ''));

  // ── create ────────────────────────────────────────────────
  router.post('/batches', async (req, res) => {
    const { name, region, domains, text, contacts } = req.body || {};
    const rawRegion = (region || process.env.ADS_REGION_DEFAULT || 'anywhere').trim();
    if (!REGION_RE.test(rawRegion)) return res.status(400).json({ error: 'Invalid region' });

    // `contacts` is [{id, domain}] from the Contacts handoff — it carries the
    // contact→domain mapping so the finished batch can be pushed to PlusVibe as
    // contacts, not bare domains. `domains`/`text` remain the ad-hoc paths.
    const links = [];
    let list = [];
    if (Array.isArray(contacts) && contacts.length) {
      for (const c of contacts) {
        const d = normalizeList([c && c.domain])[0];
        // contacts.id is a UUID — keep it as a string. Coercing with Number()
        // yielded NaN and silently dropped every contact.
        const id = c && c.id != null ? String(c.id).trim() : '';
        if (d && id) links.push({ id, domain: d });
      }
      list = normalizeList(links.map((l) => l.domain));
    } else if (Array.isArray(domains) && domains.length) list = normalizeList(domains);
    else if (typeof text === 'string' && text.trim()) list = parseDomainText(text);
    if (!list.length) return res.status(400).json({ error: 'No valid domains found in the input' });
    if (list.length > MAX_DOMAINS) return res.status(400).json({ error: `Too many domains (max ${MAX_DOMAINS})` });

    const id = crypto.randomUUID();
    const ttl = Number(process.env.ADS_CACHE_TTL_DAYS ?? 7);

    try {
      await req.db.query(
        `INSERT INTO ads_batches (id, name, region, total, status) VALUES ($1,$2,$3,$4,'running')`,
        [id, (name || '').trim() || null, rawRegion, list.length]);

      // Seed jobs. When the cache is enabled, a fresh result for (domain, region)
      // lands the job pre-completed so we don't re-scrape what we already know.
      const insert = ttl > 0
        ? `INSERT INTO ads_jobs (batch_id, domain, status, runs_ads, ad_count, is_estimate, advertisers, updated_at)
           SELECT $1, d.domain,
                  CASE WHEN c.domain IS NOT NULL THEN 'done' ELSE 'queued' END,
                  c.runs_ads, c.ad_count, c.is_estimate, c.advertisers, now()
             FROM unnest($2::text[]) AS d(domain)
             LEFT JOIN ads_domain_cache c
                    ON c.domain = d.domain AND c.region = $3
                   AND c.checked_at > now() - ($4::int * interval '1 day')
            ON CONFLICT (batch_id, domain) DO NOTHING`
        : `INSERT INTO ads_jobs (batch_id, domain, status, updated_at)
           SELECT $1, d.domain, 'queued', now() FROM unnest($2::text[]) AS d(domain)
            ON CONFLICT (batch_id, domain) DO NOTHING`;
      const params = ttl > 0 ? [id, list, rawRegion, ttl] : [id, list];
      await req.db.query(insert, params);

      // Remember which contacts this batch came from (dedupe on contact id).
      if (links.length) {
        await req.db.query(
          `INSERT INTO ads_batch_contacts (batch_id, contact_id, domain)
           SELECT $1, u.id, u.domain
             FROM unnest($2::text[], $3::text[]) AS u(id, domain)
            ON CONFLICT (batch_id, contact_id) DO NOTHING`,
          [id, links.map((l) => l.id), links.map((l) => l.domain)]);
      }

      const { rows } = await req.db.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='done')::int AS cached
           FROM ads_jobs WHERE batch_id=$1`, [id]);
      // Jobs pre-filled from ads_domain_cache never reach the worker, so stamp
      // their contacts here — otherwise a fully-cached batch would leave the
      // Contacts grid with no ads_* data to filter on.
      if (rows[0].cached) {
        await req.db.query(
          `UPDATE contacts c
              SET ads_runs_ads=j.runs_ads, ads_count=j.ad_count, ads_is_estimate=j.is_estimate,
                  ads_advertisers=j.advertisers, ads_checked_at=now()
             FROM ads_jobs j
            WHERE j.batch_id=$1 AND j.status='done'
              AND ${DOMAIN_NORM_SQL.replace(/company_domain/g, 'c.company_domain')} = j.domain`,
          [id]).catch(() => { /* non-fatal — the batch itself is still valid */ });
      }

      // A fully-cached batch has nothing to drain — close it immediately.
      if (rows[0].total === rows[0].cached) {
        await req.db.query(`UPDATE ads_batches SET status='done' WHERE id=$1`, [id]);
      }
      res.json({ id, total: rows[0].total, cached: rows[0].cached, region: rawRegion });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── full-database sweep ───────────────────────────────────
  // Queue every distinct UK company domain in contacts. Results stamp onto
  // EVERY contact at that domain (worker.stampContacts), so one check answers
  // the whole company — including contacts imported later.
  router.post('/sweep', async (req, res) => {
    const { name, region, uk_only, stale_days } = req.body || {};
    const rawRegion = (region || process.env.ADS_REGION_DEFAULT || 'anywhere').trim();
    if (!REGION_RE.test(rawRegion)) return res.status(400).json({ error: 'Invalid region' });
    try {
      // Returns as soon as the batch row exists; the ~187k-domain insert runs
      // detached and the batch shows as 'building' until it lands. Holding the
      // request open would just hit the proxy's gateway timeout.
      const r = await startSweepDetached(req.db, {
        name, region: rawRegion,
        ukOnly: uk_only !== false,
        staleDays: Number(stale_days ?? 30),
        cacheTtlDays: Number(process.env.ADS_CACHE_TTL_DAYS ?? 7),
      });
      res.json({ ...r, region: rawRegion });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Size a sweep before running it.
  router.get('/sweep/preview', async (req, res) => {
    try {
      res.json(await previewSweep(req.db, {
        ukOnly: req.query.uk_only !== 'false',
        staleDays: Number(req.query.stale_days ?? 30),
      }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Continuous mode. The queue is unchanged — this just refills it: when
  // nothing is left to do, the worker starts a fresh sweep, so the database
  // stays continuously up to date without anyone pressing anything.
  router.get('/auto', async (req, res) => {
    try {
      res.json({
        enabled: (await getSetting(req.db, 'auto_sweep', 'off')) === 'on',
        uk_only: (await getSetting(req.db, 'auto_uk_only', 'on')) === 'on',
        stale_days: Number(await getSetting(req.db, 'auto_stale_days', '30')),
        last_started: await getSetting(req.db, 'auto_last_started', null),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post('/auto', async (req, res) => {
    try {
      const on = !!(req.body && req.body.enabled);
      await setSetting(req.db, 'auto_sweep', on ? 'on' : 'off');
      if (req.body && req.body.uk_only !== undefined) await setSetting(req.db, 'auto_uk_only', req.body.uk_only ? 'on' : 'off');
      if (req.body && req.body.stale_days !== undefined) await setSetting(req.db, 'auto_stale_days', Number(req.body.stale_days) || 30);
      res.json({ ok: true, enabled: on });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── list ──────────────────────────────────────────────────
  router.get('/batches', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    try {
      const { rows } = await req.db.query(
        `SELECT b.id, b.name, b.region, b.total, b.status, b.created_at,
                COUNT(j.*) FILTER (WHERE j.status='queued')::int  AS queued,
                COUNT(j.*) FILTER (WHERE j.status='running')::int AS running,
                COUNT(j.*) FILTER (WHERE j.status='done')::int    AS done,
                COUNT(j.*) FILTER (WHERE j.status='error')::int   AS errors,
                COUNT(j.*) FILTER (WHERE j.runs_ads IS TRUE)::int  AS yes,
                COUNT(j.*) FILTER (WHERE j.runs_ads IS FALSE)::int AS no,
                MAX(j.updated_at) AS last_activity
           FROM ads_batches b LEFT JOIN ads_jobs j ON j.batch_id = b.id
          GROUP BY b.id
          ORDER BY b.created_at DESC
          LIMIT $1`, [limit]);
      res.json({ batches: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── single batch summary ──────────────────────────────────
  router.get('/batches/:id', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    try {
      const b = await req.db.query(`SELECT * FROM ads_batches WHERE id=$1`, [req.params.id]);
      if (!b.rows.length) return res.status(404).json({ error: 'Batch not found' });
      const c = await req.db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='queued')::int  AS queued,
                COUNT(*) FILTER (WHERE status='running')::int AS running,
                COUNT(*) FILTER (WHERE status='done')::int    AS done,
                COUNT(*) FILTER (WHERE status='error')::int   AS errors,
                COUNT(*) FILTER (WHERE runs_ads IS TRUE)::int  AS yes,
                COUNT(*) FILTER (WHERE runs_ads IS FALSE)::int AS no,
                COUNT(*) FILTER (WHERE status IN ('done','error')
                                   AND updated_at > now() - interval '5 minutes')::int AS done_5m
           FROM ads_jobs WHERE batch_id=$1`, [req.params.id]);
      const counts = c.rows[0];
      const perMin = counts.done_5m / 5;
      const remaining = counts.queued + counts.running;
      res.json({
        batch: b.rows[0],
        counts,
        rate_per_min: +perMin.toFixed(1),
        eta_seconds: perMin > 0 && remaining > 0 ? Math.round((remaining / perMin) * 60) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── job rows ──────────────────────────────────────────────
  router.get('/batches/:id/jobs', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    const limit = Math.min(Number(req.query.limit) || 200, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const order = SORTS[req.query.sort] || SORTS.id;

    const where = ['batch_id = $1'];
    const params = [req.params.id];
    const filter = String(req.query.status || 'all');
    if (filter === 'yes') where.push('runs_ads IS TRUE');
    else if (filter === 'no') where.push('runs_ads IS FALSE');
    else if (filter === 'error') where.push(`status = 'error'`);
    else if (filter === 'pending') where.push(`status IN ('queued','running')`);
    else if (filter === 'done') where.push(`status = 'done'`);
    if (req.query.search) {
      params.push(`%${String(req.query.search).toLowerCase()}%`);
      where.push(`domain LIKE $${params.length}`);
    }
    // Ad-count band. Rows with no count yet (queued/running/error) are excluded
    // once a bound is set — "between 5 and 50 ads" can't be true of an unchecked
    // domain, and leaving them in makes the count read as if they qualified.
    const minAds = parseInt(req.query.min_ads, 10);
    const maxAds = parseInt(req.query.max_ads, 10);
    if (Number.isFinite(minAds)) { params.push(minAds); where.push(`ad_count >= $${params.length}`); }
    if (Number.isFinite(maxAds)) { params.push(maxAds); where.push(`ad_count <= $${params.length}`); }

    try {
      const sql = `SELECT id, domain, status, attempts, runs_ads, ad_count, is_estimate,
                          advertisers, error, updated_at
                     FROM ads_jobs WHERE ${where.join(' AND ')}
                    ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const { rows } = await req.db.query(sql, [...params, limit, offset]);
      const total = await req.db.query(
        `SELECT COUNT(*)::int AS n FROM ads_jobs WHERE ${where.join(' AND ')}`, params);
      res.json({ jobs: rows, total: total.rows[0].n, limit, offset });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── resolve a filtered result set back to contact ids ─────
  // The push to PlusVibe goes through /api/contacts/verify-and-push, which takes
  // contact_ids — so the ads page asks here for "the contacts behind the rows
  // currently filtered", then hands those ids to the normal push (verifier and
  // all its guards included). Defaults to the domains that DO run ads.
  router.get('/batches/:id/contact-ids', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    const filter = String(req.query.status || 'yes');

    const where = ['j.batch_id = $1'];
    if (filter === 'yes') where.push('j.runs_ads IS TRUE');
    else if (filter === 'no') where.push('j.runs_ads IS FALSE');
    else if (filter === 'done') where.push(`j.status = 'done'`);
    // 'all' adds nothing.

    // Optional ad-count band, so you can push e.g. only domains already spending
    // heavily (or only those with a token presence).
    const params = [req.params.id];
    const cMin = parseInt(req.query.min_ads, 10);
    const cMax = parseInt(req.query.max_ads, 10);
    if (Number.isFinite(cMin)) { params.push(cMin); where.push(`j.ad_count >= $${params.length}`); }
    if (Number.isFinite(cMax)) { params.push(cMax); where.push(`j.ad_count <= $${params.length}`); }

    try {
      const linked = await req.db.query(
        `SELECT COUNT(*)::int AS n FROM ads_batch_contacts WHERE batch_id=$1`, [req.params.id]);
      const hasLinks = linked.rows[0].n > 0;

      // Two ways to resolve results back to contacts:
      //   linked — the exact contacts the batch was started from (preferred).
      //   domain — every contact whose company domain matches a result.
      // The fallback matters: batches created before contact-linking existed
      // have no links, and a pasted list can still correspond to real contacts.
      // It uses idx_contacts_domain_norm, so it's an index scan, not a seq scan.
      const sql = hasLinks
        ? `SELECT DISTINCT bc.contact_id AS id
             FROM ads_batch_contacts bc
             JOIN ads_jobs j ON j.batch_id = bc.batch_id AND j.domain = bc.domain
            WHERE ${where.join(' AND ')}`
        : `SELECT DISTINCT c.id
             FROM contacts c
             JOIN ads_jobs j ON j.domain = ${DOMAIN_NORM_SQL.replace(/company_domain/g, 'c.company_domain')}
            WHERE ${where.join(' AND ')}`;   // c.id is a UUID — returned as text
      const { rows } = await req.db.query(sql, params);
      const ids = rows.map((r) => String(r.id));   // UUIDs — never Number() these
      res.json({
        contact_ids: ids,
        count: ids.length,
        linked_contacts: linked.rows[0].n,
        matched_by: hasLinks ? 'linked' : 'domain',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── export ────────────────────────────────────────────────
  router.get('/batches/:id/export.csv', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).send('Invalid batch id');
    const csv = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    try {
      const b = await req.db.query(`SELECT name, created_at FROM ads_batches WHERE id=$1`, [req.params.id]);
      if (!b.rows.length) return res.status(404).send('Batch not found');
      const slug = (b.rows[0].name || 'ads').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ads';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-ads-results.csv"`);
      res.write('domain,runs_ads,ad_count,is_estimate,advertisers,status,attempts,checked_at,error\n');

      // Page through so a 50k-row export never buffers the whole set in memory.
      const PAGE = 2000;
      for (let offset = 0; ; offset += PAGE) {
        const { rows } = await req.db.query(
          `SELECT domain, status, attempts, runs_ads, ad_count, is_estimate, advertisers, error, updated_at
             FROM ads_jobs WHERE batch_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
          [req.params.id, PAGE, offset]);
        if (!rows.length) break;
        for (const r of rows) {
          const adv = Array.isArray(r.advertisers) ? r.advertisers.join(' | ') : '';
          const yn = r.runs_ads === true ? 'YES' : r.runs_ads === false ? 'NO' : (r.status === 'error' ? 'ERROR' : '');
          res.write([
            csv(r.domain), yn, csv(r.ad_count), r.is_estimate ? 'yes' : '',
            csv(adv), csv(r.status), csv(r.attempts),
            csv(r.updated_at ? new Date(r.updated_at).toISOString() : ''), csv(r.error),
          ].join(',') + '\n');
        }
        if (rows.length < PAGE) break;
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
      else res.end();
    }
  });

  // ── controls ──────────────────────────────────────────────
  const setStatus = (status) => async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    try {
      const { rowCount } = await req.db.query(
        `UPDATE ads_batches SET status=$2 WHERE id=$1`, [req.params.id, status]);
      if (!rowCount) return res.status(404).json({ error: 'Batch not found' });
      res.json({ ok: true, status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  };
  router.post('/batches/:id/pause', setStatus('paused'));
  router.post('/batches/:id/resume', setStatus('running'));

  // Stop a batch for good WITHOUT losing what it already found: drop everything
  // still queued and close it. Distinct from pause (resumable) and delete
  // (destroys the results too) — the middle option you want when a big batch is
  // half-useful and you don't want it eating the queue any longer.
  router.post('/batches/:id/cancel', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    try {
      const r = await req.db.query(
        `DELETE FROM ads_jobs WHERE batch_id=$1 AND status='queued'`, [req.params.id]);
      // Running jobs are mid-flight in a worker; let them land rather than
      // orphaning them. Once they finish, nothing is left queued.
      await req.db.query(
        `UPDATE ads_batches SET status='done' WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, dropped: r.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Global stop/start — one control when several batches are in flight.
  router.post('/pause-all', async (req, res) => {
    try {
      // Explicit flag, so continuous mode knows this was a deliberate global
      // stop rather than just an empty runnable queue.
      await setSetting(req.db, 'global_pause', 'on');
      const r = await req.db.query(`UPDATE ads_batches SET status='paused' WHERE status='running'`);
      res.json({ ok: true, paused: r.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post('/resume-all', async (req, res) => {
    try {
      await setSetting(req.db, 'global_pause', 'off');
      // Only revive batches that still have work; a finished batch stays done.
      const r = await req.db.query(
        `UPDATE ads_batches b SET status='running'
          WHERE b.status='paused'
            AND EXISTS (SELECT 1 FROM ads_jobs j WHERE j.batch_id=b.id AND j.status IN ('queued','error'))`);
      res.json({ ok: true, resumed: r.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/batches/:id/retry-errors', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    try {
      const r = await req.db.query(
        `UPDATE ads_jobs SET status='queued', attempts=0, error=NULL,
                             locked_at=NULL, locked_by=NULL, updated_at=now()
          WHERE batch_id=$1 AND status='error'`, [req.params.id]);
      if (r.rowCount) await req.db.query(`UPDATE ads_batches SET status='running' WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, requeued: r.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/batches/:id', async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Invalid batch id' });
    try {
      const { rowCount } = await req.db.query(`DELETE FROM ads_batches WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, deleted: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── diagnostics ───────────────────────────────────────────
  // Is the persistence path actually wired? Mirrors /api/solar/diag. Answers
  // "why is the Contacts Google Ads filter doing nothing / erroring" without
  // shell access — the ads_* ALTERs can lose a lock race on the busy contacts
  // table, and that used to fail silently.
  router.get('/diag', async (req, res) => {
    const { contactColumnsPresent, ensureContactColumns, CONTACT_COLUMNS } = require('./lib/adscheck/schema');
    const out = { expected_columns: CONTACT_COLUMNS.map(([c]) => c) };
    try {
      const cols = await req.db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='contacts' AND column_name LIKE 'ads_%' ORDER BY column_name`);
      out.present_columns = cols.rows.map((r) => r.column_name);
      out.columns_ready = await contactColumnsPresent(req.db);
      out.filter_enabled = req.db._hasAdsColumns === true;

      if (out.columns_ready) {
        const c = await req.db.query(
          `SELECT COUNT(*) FILTER (WHERE ads_checked_at IS NOT NULL)::int AS checked,
                  COUNT(*) FILTER (WHERE ads_runs_ads IS TRUE)::int  AS runs_ads,
                  COUNT(*) FILTER (WHERE ads_runs_ads IS FALSE)::int AS no_ads
             FROM contacts`);
        out.contacts = c.rows[0];
      }
      // ?fix=1 retries the migration on demand, for when a deploy lost the race.
      if (req.query.fix) {
        out.fix_result = await ensureContactColumns(req.db, { attempts: 3 });
        req.db._hasAdsColumns = out.fix_result;
      }
      const idx = await req.db.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='contacts' AND indexname IN
           ('idx_contacts_domain_norm','idx_contacts_ads_runs_ads')`);
      out.indexes = idx.rows.map((r) => r.indexname);

      // ?scope=1 — how big is a full sweep, and what would it cost in proxy
      // bandwidth? Measured at ~3.88 MB per domain checked (JS-heavy page).
      // COUNT(DISTINCT) over ~600k rows, so it's opt-in rather than always-on.
      if (req.query.scope) {
        const MB_PER_DOMAIN = 3.88;
        const d = await req.db.query(
          `SELECT COUNT(DISTINCT ${DOMAIN_NORM_SQL})::int AS domains,
                  COUNT(*) FILTER (WHERE company_domain IS NOT NULL AND company_domain <> '')::int AS with_domain,
                  COUNT(*)::int AS contacts
             FROM contacts`);
        const row = d.rows[0];
        const todo = out.contacts
          ? Math.max(row.domains - 0, 0)   // cached domains still cost nothing to re-check
          : row.domains;
        out.scope = {
          contacts: row.contacts,
          contacts_with_domain: row.with_domain,
          distinct_domains: row.domains,
          full_sweep_gb: +((todo * MB_PER_DOMAIN) / 1024).toFixed(1),
          mb_per_domain: MB_PER_DOMAIN,
        };
      }
    } catch (e) { out.error = e.message; }
    res.json(out);
  });

  // Run ONE navigation and report exactly what the server's Chromium sees.
  // A generic "waitForFunction timeout" can't distinguish "Google served us a
  // consent/blocked interstitial" from "Chromium rendered nothing at all", and
  // those need opposite fixes — so dump the real page state.
  //   GET /api/ads/debug?domain=kingspan.com[&region=anywhere][&shot=1]
  router.get('/debug', async (req, res) => {
    const domain = String(req.query.domain || 'kingspan.com');
    const region = String(req.query.region || 'anywhere');
    // Reuse the worker's browser when there is one, but never depend on it —
    // the request may land on a replica with ADS_WORKER=0, or within the 10s
    // before the worker starts after a redeploy. Diagnostics that only work
    // when things are already healthy aren't diagnostics.
    const worker = typeof getWorker === 'function' ? getWorker() : null;
    const { BrowserPool, findChromium } = require('./lib/adscheck/browser');
    const pool = worker ? worker.browsers : new BrowserPool();
    const ownPool = !worker;

    const out = { domain, region, chromium: findChromium(), used_worker_browser: !!worker };
    let page;
    try {
      const t0 = Date.now();
      const context = await pool.getContext();
      out.launch_ms = Date.now() - t0;
      page = await context.newPage();
      page.on('console', (m) => { (out.console = out.console || []).push(`${m.type()}: ${m.text()}`.slice(0, 200)); });

      const t1 = Date.now();
      const resp = await page.goto(
        `https://adstransparency.google.com/?region=${encodeURIComponent(region)}&domain=${encodeURIComponent(domain)}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 });
      out.nav_ms = Date.now() - t1;
      out.http_status = resp && resp.status();
      out.final_url = page.url();
      out.title = await page.title();

      // Give it the same window the real check gets, then report regardless.
      await page.waitForTimeout(12000);
      const state = await page.evaluate(() => ({
        text: (document.body.innerText || '').slice(0, 1500),
        html_len: document.documentElement.outerHTML.length,
        scripts: document.querySelectorAll('script').length,
      }));
      out.text = state.text;
      out.text_len = state.text.length;
      out.html_len = state.html_len;
      out.scripts = state.scripts;
      out.has_count = /(~?\s*[\d,]+)\s+ads?\b/i.test(state.text);
      out.has_no_ads = /No ads found/i.test(state.text);
      out.looks_blocked = /unusual traffic|not a robot|captcha|consent|before you continue|sorry/i.test(state.text);
      if (req.query.shot) out.screenshot = 'data:image/png;base64,'
        + (await page.screenshot({ type: 'png', fullPage: false })).toString('base64');
      res.json(out);
    } catch (err) {
      out.error = err.message;
      try { if (page) { out.text_on_error = (await page.evaluate(() => (document.body.innerText || '').slice(0, 1500))); out.final_url = page.url(); } } catch { /* page may be dead */ }
      res.status(200).json(out);
    } finally {
      if (page) await page.close().catch(() => {});
      if (ownPool) await pool.close().catch(() => {}); // don't leak a browser per debug call
    }
  });

  // ── health ────────────────────────────────────────────────
  router.get('/health', async (req, res) => {
    try {
      const w = await req.db.query(
        `SELECT id, in_flight, concurrency, browser_ok, note, last_heartbeat,
                (last_heartbeat > now() - interval '60 seconds') AS alive
           FROM ads_workers ORDER BY id`);
      const q = await req.db.query(
        `SELECT COUNT(*) FILTER (WHERE status='queued')::int  AS queued,
                COUNT(*) FILTER (WHERE status='running')::int AS running,
                COUNT(*) FILTER (WHERE status IN ('done','error')
                                   AND updated_at > now() - interval '5 minutes')::int AS done_5m,
                COUNT(*) FILTER (WHERE status='done' AND updated_at::date = now()::date)::int AS done_today
           FROM ads_jobs`);
      const local = typeof getWorker === 'function' ? getWorker() : null;
      res.json({
        ok: true,
        workers: w.rows,
        queue: q.rows[0],
        rate_per_min: +(q.rows[0].done_5m / 5).toFixed(1),
        local_worker: local ? {
          id: local.id,
          running: local.running,
          in_flight: local.inFlight.size,
          // Proxy health. Webshare bills by bandwidth, so an exhausted proxy is
          // a routine, expected state — surface it rather than letting it look
          // like Google throttling.
          proxies_healthy: local.browsers.proxyContexts.length,
          proxies_dead: (local.browsers.deadProxies || []).map((d) => `${d.label}: ${d.why}`),
        } : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
