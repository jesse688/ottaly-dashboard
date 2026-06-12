'use strict';
/**
 * routes/revenue.js
 * Revenue & non-lead endpoints:
 *   GET  /api/gbp-zar-rate
 *   GET  /api/avg-lead-price
 *   GET  /api/revenue/leads
 *   POST /api/nonlead/mark
 *   POST /api/nonlead/restore
 *   GET  /api/revenue/stats-by-workspace
 *   GET  /api/revenue/manual-entries
 *   POST /api/revenue/manual-entries
 *   DELETE /api/revenue/manual-entries/:id
 *
 * Extracted from server.js lines ~2578–2691 and ~8146–8190.
 * Mounted with: app.use('/', revenueRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {object}   ctx.Sentry
 * @param {object}   ctx.apiCache
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 * @param {object}   ctx.revenueCache            - live reference to the cache object
 * @param {Function} ctx.isRevenueExcludedWorkspace
 * @param {Function} ctx.isPvNonLeadLabel
 */
function makeRouter(ctx) {
  const {
    db, Sentry, apiCache,
    requireSession, requireAdmin,
    revenueCache,
    isRevenueExcludedWorkspace, isPvNonLeadLabel,
  } = ctx;

  const router = express.Router();

  // ── GBP→ZAR exchange rate ─────────────────────────────────
  let _zarRateCache = { rate: null, fetchedAt: 0 };
  router.get('/api/gbp-zar-rate', requireSession, async (req, res) => {
    const now = Date.now();
    res.set('Cache-Control', 'public, s-maxage=1800, max-age=1800');
    if (_zarRateCache.rate && now - _zarRateCache.fetchedAt < 30 * 60 * 1000) {
      return res.json({ rate: _zarRateCache.rate, source: 'cache' });
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const r = await fetch('https://api.frankfurter.app/latest?from=GBP&to=ZAR', { signal: controller.signal });
      clearTimeout(t);
      const d = await r.json();
      const rate = d?.rates?.ZAR;
      if (rate && rate > 0) {
        _zarRateCache = { rate, fetchedAt: now };
        return res.json({ rate, source: 'live' });
      }
    } catch {}
    res.json({ rate: _zarRateCache.rate || 23.5, source: 'fallback' });
  });

  // ── All-time average lead price ────────────────────────────
  router.get('/api/avg-lead-price', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const overrides = db.prepare('SELECT email, active FROM nonlead_overrides').all();
    const nonleadMap = {};
    overrides.forEach(o => { nonleadMap[o.email.toLowerCase()] = o; });

    const livePrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
    const livePriceMap = {};
    livePrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

    const leads = (revenueCache.leads || []).filter(l => {
      if (isRevenueExcludedWorkspace(l)) return false;
      const override  = nonleadMap[(l.lead_email || '').toLowerCase()];
      const pvNonlead = Boolean(l.pv_nonlead || isPvNonLeadLabel(l.label));
      return !(override?.active || pvNonlead);
    });

    const totalRevenue = leads.reduce((s, l) => s + (livePriceMap[l.workspace_id] ?? l.lead_price ?? 0), 0);
    const totalLeads   = leads.length;
    const avg          = totalLeads > 0 ? totalRevenue / totalLeads : 0;

    res.json({
      avg_lead_price_gbp: parseFloat(avg.toFixed(2)),
      total_leads:        totalLeads,
      total_revenue:      parseFloat(totalRevenue.toFixed(2)),
      period:             'all-time',
    });
  });

  // ── Revenue leads list ─────────────────────────────────────
  router.get('/api/revenue/leads', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const cacheKey = 'revenue_leads';
    const cached = apiCache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const overrides = db.prepare(`SELECT email, reason, marked_at, active FROM nonlead_overrides`).all();
    const nonleadMap = {};
    overrides.forEach(o => { nonleadMap[o.email.toLowerCase()] = o; });

    const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
    const livePriceMap = {};
    currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

    const leads = (revenueCache.leads || []).filter(l => !isRevenueExcludedWorkspace(l)).map(l => {
      const o         = nonleadMap[(l.lead_email || '').toLowerCase()];
      const livePrice = livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
      const pvNonlead = Boolean(l.pv_nonlead || isPvNonLeadLabel(l.label));
      return {
        ...l,
        lead_price:     livePrice,
        is_nonlead:     o?.active || pvNonlead ? true : false,
        nonlead_reason: o?.active ? o.reason : (pvNonlead ? 'PlusVibe label: Non Lead' : ''),
        nonlead_date:   o?.active ? o.marked_at : (pvNonlead ? l.date : ''),
      };
    });
    const result = { ...revenueCache, leads };
    apiCache.set(cacheKey, result, 60);
    res.json(result);
  });

  // ── Non-lead mark / restore ───────────────────────────────
  router.post('/api/nonlead/mark', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { email, reason } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });
    db.prepare(`INSERT INTO nonlead_overrides (email, reason, active) VALUES (?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, marked_at=datetime('now'), active=1`)
      .run(email.toLowerCase(), reason || '');
    res.json({ ok: true });
  });

  router.post('/api/nonlead/restore', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });
    db.prepare(`UPDATE nonlead_overrides SET active=0 WHERE email=?`).run(email.toLowerCase());
    res.json({ ok: true });
  });

  // ── Revenue stats by workspace ────────────────────────────
  router.get('/api/revenue/stats-by-workspace', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
    const livePriceMap  = {};
    currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });
    const manualNonleads = new Set(
      db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
        .map(r => String(r.email || '').toLowerCase())
    );

    const counts = {};
    (revenueCache.leads || []).forEach(l => {
      if (isRevenueExcludedWorkspace(l)) return;
      if (manualNonleads.has(String(l.lead_email || '').toLowerCase())) return;
      if (l.pv_nonlead || isPvNonLeadLabel(l.label)) return;
      if (!counts[l.workspace_id]) counts[l.workspace_id] = { delivered: 0, revenue: 0 };
      counts[l.workspace_id].delivered++;
      counts[l.workspace_id].revenue += livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
    });
    res.json(counts);
  });

  // ── Manual revenue entries (Postgres) ────────────────────
  router.get('/api/revenue/manual-entries', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json([]);
      const { rows } = await pgdb.query(
        `SELECT id, workspace_id, workspace_name, amount, description, entry_date, created_at
         FROM revenue_manual_entries ORDER BY entry_date DESC, created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/revenue/manual-entries', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      const { workspace_id, workspace_name, amount, description, entry_date } = req.body || {};
      if (!workspace_id || !amount || !entry_date)
        return res.status(400).json({ error: 'workspace_id, amount and entry_date required' });
      const { rows } = await pgdb.query(
        `INSERT INTO revenue_manual_entries (workspace_id, workspace_name, amount, description, entry_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspace_id, workspace_name || '', parseFloat(amount) || 0, description || '', entry_date]
      );
      res.json(rows[0]);
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/revenue/manual-entries/:id', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      await pgdb.query('DELETE FROM revenue_manual_entries WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRouter;
