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
const { ensureSchema } = require('./lib/adscheck/schema');
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
    const { name, region, domains, text } = req.body || {};
    const rawRegion = (region || process.env.ADS_REGION_DEFAULT || 'anywhere').trim();
    if (!REGION_RE.test(rawRegion)) return res.status(400).json({ error: 'Invalid region' });

    let list = [];
    if (Array.isArray(domains) && domains.length) list = normalizeList(domains);
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

      const { rows } = await req.db.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='done')::int AS cached
           FROM ads_jobs WHERE batch_id=$1`, [id]);
      // A fully-cached batch has nothing to drain — close it immediately.
      if (rows[0].total === rows[0].cached) {
        await req.db.query(`UPDATE ads_batches SET status='done' WHERE id=$1`, [id]);
      }
      res.json({ id, total: rows[0].total, cached: rows[0].cached, region: rawRegion });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
        local_worker: local ? { id: local.id, running: local.running, in_flight: local.inFlight.size } : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
