// Contacts v2 API, mounted at /api/cx behind requireSession.
//
// Read-only apart from saved views. Pushing still goes through the existing,
// battle-tested routes in server.js (/api/contacts/sendability,
// /api/contacts/verify-and-push, /api/contacts/push-jobs). What this router
// adds is ONE resolved filter object per request, returned to the page as
// `resolved`, which the page hands to those push routes unchanged. That is how
// the list, the counts, the export and the push all mean the same contacts.

const express = require('express');
const { parseFilters, applyClientRules, FILTER_KEYS } = require('./lib/contacts-next/filters');
const Q = require('./lib/contacts-next/queries');
const maintenance = require('./lib/contacts-next/maintenance');

const DEFAULT_TENANT = 'ottaly-global';

module.exports = ({ pgdb, getSqlite }) => {
  const router = express.Router();
  const sqlite = () => { try { return getSqlite ? getSqlite() : null; } catch { return null; } };

  // Tenant scope of the contacts table. Not the same thing as the CLIENT
  // (a PlusVibe workspace id) that filters and guards target. Deliberately NOT
  // read from the x-workspace-id header as the original routes do: any signed
  // in user could then name any tenant, and each new name would start a
  // whole-table scan for the pockets totals.
  const tenantOf = (req) => req.user?.workspace_id || DEFAULT_TENANT;
  // saved_views upserts on (workspace_id, name). Keeping v2 views under their
  // own key means a v2 view can never overwrite an original-page view of the
  // same name, and the original page never lists a view it cannot load.
  const viewScope = (req) => `${tenantOf(req)}#v2`;

  // Index upkeep and the one-off head-count fix run in the background a few
  // minutes after boot. See lib/contacts-next/maintenance.js.
  maintenance.schedule(pgdb);

  // Parse + resolve. `client` is the selected client's PlusVibe workspace id.
  function resolve(req) {
    const src = req.method === 'GET' ? req.query : (req.body && req.body.filters) || req.body || {};
    const client = String((req.method === 'GET' ? req.query.client : req.body?.client) || '').trim();
    const typed = parseFilters(src);
    const { filters, rules, client: clientInfo } = applyClientRules(typed, sqlite(), client || null);
    // "Name: any" must be said out loud. The push guard reads a MISSING hasName
    // as 'first_only', so leaving it off would let the list show nameless
    // contacts that the ready-to-send count and the push then quietly drop.
    // An explicit empty string means "any" to the guard and adds no clause here.
    if (!('hasName' in filters)) filters.hasName = '';
    return { typed, filters, rules, clientInfo, client };
  }

  const fail = (res, where, err) => {
    console.error(`[contacts-next] ${where}:`, err.message);
    res.status(500).json({ error: err.message });
  };

  // ── Page shell: everything needed before the first search ────────────────
  router.get('/bootstrap', async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const sq = sqlite();
      let clients = [];
      if (sq) {
        try {
          const rows = sq.prepare(`
            SELECT c.workspace_id, c.workspace_name, COALESCE(c.client_status, 'active') AS client_status,
                   v.vertical
              FROM clients c LEFT JOIN client_verticals v ON v.workspace_id = c.workspace_id
             WHERE c.workspace_id IS NOT NULL AND c.workspace_id != ''
             ORDER BY c.workspace_name COLLATE NOCASE`).all();
          const seen = new Set();
          for (const r of rows) {
            if (seen.has(r.workspace_id)) continue;
            seen.add(r.workspace_id);
            clients.push({ id: r.workspace_id, name: r.workspace_name, status: r.client_status, vertical: r.vertical || '' });
          }
        } catch (e) { console.warn('[contacts-next] clients lookup failed:', e.message); }
      }
      let defaults = {};
      try {
        const r = await pgdb.query(`SELECT value FROM app_settings WHERE key = 'contact_filter_defaults'`);
        const v = r.rows[0]?.value;
        defaults = typeof v === 'string' ? JSON.parse(v) : (v || {});
      } catch { /* optional */ }
      const [sources, gateways, rows] = await Promise.all([
        Q.sourceCounts(pgdb, tenant).catch(() => []),
        Q.gatewayNames(pgdb),
        Q.tableRows(pgdb).catch(() => 0),
      ]);
      // Warm the whole-table totals the pockets panel needs.
      Q.supplyTotals(pgdb, tenant);
      res.json({
        // Shown as a banner when set. Used on a developer machine running a
        // sample of the data, so small numbers are not mistaken for real ones.
        notice: process.env.CONTACTS_NEXT_NOTICE || '',
        tenant, clients, sources, gateways, defaults,
        tableRows: rows, countCap: Q.COUNT_CAP, sizeBuckets: Q.SIZE_BUCKETS,
        sorts: Object.keys(Q.SORTS), facets: Object.keys(Q.FACETS), filterKeys: FILTER_KEYS,
      });
    } catch (err) { fail(res, 'bootstrap', err); }
  });

  // ── Search ───────────────────────────────────────────────────────────────
  router.get('/search', async (req, res) => {
    try {
      const { filters, rules, clientInfo, client } = resolve(req);
      const wantsAds = !!(filters.adsRunsAds || filters.adsMinCount || filters.adsMaxCount);
      if (wantsAds && pgdb._hasAdsColumns !== true) {
        return res.status(409).json({ error: 'Google Ads filter unavailable: the ads columns are not on the contacts table yet.' });
      }
      const out = await Q.search(pgdb, tenantOf(req), filters, {
        sort: req.query.sort, dir: req.query.dir, limit: req.query.limit, offset: req.query.offset,
      });
      // `resolved` is the exact filter object the query ran with. The page
      // passes it to sendability and to the push as target_filters.
      res.json({ ...out, rules, client: client ? clientInfo : null, resolved: filters });
    } catch (err) {
      if (err.tooSlow) return res.status(422).json({ error: err.message });
      fail(res, 'search', err);
    }
  });

  // The (capped) total for the current filter. The list answers before a slow
  // count has finished; the page then asks here. Shares the in-flight count
  // the search already started, so it costs nothing extra.
  router.get('/count', async (req, res) => {
    try {
      const { filters } = resolve(req);
      const c = await Q.cappedCount(pgdb, tenantOf(req), filters);
      res.json({ total: c.count, capped: c.capped, countUnknown: !!c.unknown });
    } catch (err) { fail(res, 'count', err); }
  });

  // The resolved filter for the page's current state, without running a
  // search. The send dialog calls this at the moment of sending, so the filter
  // it hands to the push can never be a stale or missing one.
  router.get('/resolve', (req, res) => {
    try {
      const { filters, rules, clientInfo, client } = resolve(req);
      res.json({ resolved: filters, rules, client: client ? clientInfo : null });
    } catch (err) { fail(res, 'resolve', err); }
  });

  // ── Counts beside each filter value ──────────────────────────────────────
  router.get('/facets', async (req, res) => {
    try {
      const { filters } = resolve(req);
      const dims = String(req.query.dims || '').split(',').map(s => s.trim()).filter(Boolean);
      res.json({ facets: await Q.facets(pgdb, tenantOf(req), filters, dims) });
    } catch (err) { fail(res, 'facets', err); }
  });

  // ── Funnel numbers for the current filter ────────────────────────────────
  router.get('/summary', async (req, res) => {
    try {
      const { filters } = resolve(req);
      res.json(await Q.summary(pgdb, tenantOf(req), filters, { freshVerdictDays: req.query.freshVerdictDays }));
    } catch (err) { fail(res, 'summary', err); }
  });

  // ── What has worked for a client, and how much is left ───────────────────
  router.get('/pockets', async (req, res) => {
    try {
      const client = String(req.query.client || '').trim();
      if (!client) return res.status(400).json({ error: 'client required' });
      const data = await Q.pockets(pgdb, tenantOf(req), client);
      // Which of this client's campaigns have a saved filter to recall.
      let saved = [];
      try { saved = (await pgdb.listCampaignFilters()).filter(r => r.workspace_id === client); } catch { /* optional */ }
      const byId = new Map(saved.map(r => [String(r.campaign_id), r]));
      const campaigns = data.campaigns.map(c => ({ ...c, hasSavedFilter: byId.has(String(c.campaign_id)) }));
      res.json({ ...data, campaigns });
    } catch (err) { fail(res, 'pockets', err); }
  });

  // Saved filter of one campaign, normalised to v2 filter keys.
  router.get('/campaign-filter', async (req, res) => {
    try {
      const client = String(req.query.client || '').trim();
      const campaign = String(req.query.campaign || '').trim();
      const rows = await pgdb.listCampaignFilters();
      const row = rows.find(r => r.workspace_id === client && String(r.campaign_id) === campaign);
      if (!row) return res.status(404).json({ error: 'No saved filter for that campaign' });
      let raw = row.filters;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
      const filters = parseFilters(raw || {});
      // The client is re-applied from the picker, not from the saved blob.
      delete filters.cooldownWorkspace; delete filters.vertical;
      res.json({ campaign_name: row.campaign_name, saved_at: row.saved_at, filters });
    } catch (err) { fail(res, 'campaign-filter', err); }
  });

  // ── Saved views (v2) ─────────────────────────────────────────────────────
  // Stored in the existing saved_views table. A v2 view's `filters` text is a
  // JSON object {v:2, client, filters, sort, dir, cols}; the original page's
  // views are location.hash strings, so the two cannot be confused and each
  // page lists only its own.
  const parseView = (row) => {
    const t = String(row.filters || '');
    if (!t.startsWith('{')) return null;
    try {
      const o = JSON.parse(t);
      if (o && o.v === 2) return { id: row.id, name: row.name, updated_at: row.updated_at || row.created_at, state: o };
    } catch { /* not ours */ }
    return null;
  };
  router.get('/views', async (req, res) => {
    try {
      const rows = await pgdb.listSavedViews(viewScope(req));
      res.json({ views: rows.map(parseView).filter(Boolean) });
    } catch (err) { fail(res, 'views', err); }
  });
  router.post('/views', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      if (name.length > 80) return res.status(400).json({ error: 'name too long (max 80)' });
      const st = req.body?.state || {};
      const state = {
        v: 2,
        client: String(st.client || ''),
        filters: parseFilters(st.filters || {}),
        sort: String(st.sort || 'best'), dir: st.dir === 'asc' ? 'asc' : 'desc',
        cols: Array.isArray(st.cols) ? st.cols.map(String).slice(0, 60) : undefined,
      };
      const view = await pgdb.saveView(viewScope(req), name, JSON.stringify(state));
      res.json({ view: parseView(view) || { id: view?.id, name, state } });
    } catch (err) { fail(res, 'views.save', err); }
  });
  router.delete('/views/:id', async (req, res) => {
    try {
      res.json({ deleted: await pgdb.deleteSavedView(viewScope(req), req.params.id) });
    } catch (err) { fail(res, 'views.delete', err); }
  });

  // ── CSV export of the current filter, streamed ───────────────────────────
  // Pages by id (keyset) and writes each page as it arrives, so a large export
  // never sits in memory as one string. `clean=1` keeps only verified-safe,
  // not-opted-out, not-bounced rows (for a file that will be sent to).
  router.get('/export.csv', async (req, res) => {
    const MAX_ROWS = 200000;
    const PAGE = 5000;
    try {
      const { filters } = resolve(req);
      const cleanOnly = req.query.clean === '1' || req.query.clean === 'true';
      const cols = pgdb.constructor.DATA_EXPORT_COLUMNS;
      const cell = (v) => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString();
        if (Array.isArray(v)) v = v.join('; ');
        else if (typeof v === 'object') v = JSON.stringify(v);
        let s = String(v);
        // Spreadsheet formula injection guard: a cell starting = + - @ is run
        // as a formula by Excel/Sheets.
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contacts-${stamp}.csv"`);
      res.write('﻿' + cols.join(',') + '\n');
      let afterId = null;
      let written = 0;
      let aborted = false;
      req.on('close', () => { aborted = true; });
      while (!aborted && written < MAX_ROWS) {
        const rows = await pgdb.exportContactsData(tenantOf(req), filters, Math.min(PAGE, MAX_ROWS - written), afterId, cleanOnly);
        if (!rows.length) break;
        let chunk = '';
        for (const r of rows) chunk += cols.map(c => cell(r[c])).join(',') + '\n';
        written += rows.length;
        afterId = rows[rows.length - 1].id;
        if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok));
        if (rows.length < PAGE) break;
      }
      // A streamed file has no status code left to change once rows have gone
      // out, so say it in the file: a short export must never look complete.
      if (written >= MAX_ROWS) res.write(`"STOPPED AT ${MAX_ROWS} ROWS. Narrow the filter to export the rest."\n`);
      res.end();
    } catch (err) {
      console.error('[contacts-next] export:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else { res.write('"EXPORT FAILED PART WAY. This file is incomplete."\n'); res.end(); }
    }
  });

  // ── One contact, for the row drawer ──────────────────────────────────────
  router.get('/contact/:id', async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
      const r = await pgdb.query(
        `SELECT c.*, (${pgdb.constructor.TIER_SQL}) AS tier FROM contacts c WHERE c.id = $1 AND c.workspace_id = $2`,
        [req.params.id, tenantOf(req)]);
      const c = r.rows[0];
      if (!c) return res.status(404).json({ error: 'Not found' });
      delete c.search_tsv; delete c.ch_data;
      let facts = [];
      try {
        const f = await pgdb.query(
          `SELECT attribute, value, vertical, quote, observed_at FROM reply_facts
            WHERE LOWER(lead_email) = LOWER($1) OR company_domain = LOWER(SPLIT_PART($1, '@', 2))
            ORDER BY observed_at DESC LIMIT 20`, [c.email]);
        facts = f.rows;
      } catch { /* optional */ }
      res.json({ contact: c, facts });
    } catch (err) { fail(res, 'contact', err); }
  });

  return router;
};
