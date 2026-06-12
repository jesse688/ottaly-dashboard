'use strict';
/**
 * routes/campaigns.js
 * Campaign-related endpoints:
 *   GET  /api/campaigns/intelligence
 *   POST /api/campaigns/apply-optimisation
 *   GET  /api/pv/workspaces
 *   GET  /api/pv/campaigns
 *   POST /api/pv/push-contacts
 *   GET  /api/pv/workspace-leads
 *   GET  /api/campaign-filters
 *   POST /api/campaign-filters
 *   DELETE /api/campaign-filters/:workspace_id/:campaign_id
 *
 * Extracted from server.js.
 * Mounted with: app.use('/', campaignRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.Sentry
 * @param {object}   ctx.apiCache
 * @param {string}   ctx.PLUSVIBE_KEY
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.pvFetch        - rate-limited PlusVibe fetch helper
 * @param {object}   ctx.campaignCache  - in-memory campaign intelligence cache
 */
function makeRouter(ctx) {
  const {
    Sentry, apiCache,
    PLUSVIBE_KEY,
    requireSession, pvFetch,
    campaignCache,
  } = ctx;

  const router = express.Router();

  // ── Campaign intelligence (cached list) ───────────────────
  router.get('/api/campaigns/intelligence', requireSession, (req, res) => {
    const cacheKey = 'campaigns_intelligence';
    const cached = apiCache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);
    apiCache.set(cacheKey, campaignCache, 120);
    res.json(campaignCache);
  });

  // ── Apply A/B optimisation (pause losing variants) ────────
  router.post('/api/campaigns/apply-optimisation', requireSession, async (req, res) => {
    const { workspace_id, campaign_id, winning_variant_id, losing_variant_ids } = req.body || {};
    if (!workspace_id || !campaign_id || !winning_variant_id || !Array.isArray(losing_variant_ids))
      return res.status(400).json({ error: 'workspace_id, campaign_id, winning_variant_id, and losing_variant_ids required' });
    try {
      const results = [];
      for (const vid of losing_variant_ids) {
        try {
          const r = await pvFetch(`/campaigns/${campaign_id}/subsequences/${vid}/pause?workspace_id=${workspace_id}`, 3, { method: 'POST', body: {} });
          results.push({ id: vid, ok: true, result: r });
        } catch (err) {
          results.push({ id: vid, ok: false, error: err.message });
        }
      }
      res.json({ ok: true, results });
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PlusVibe proxy: workspaces ─────────────────────────────
  router.get('/api/pv/workspaces', async (req, res) => {
    try {
      const r = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
        headers: { 'x-api-key': PLUSVIBE_KEY },
      });
      if (!r.ok) throw new Error(`PlusVibe ${r.status}`);
      res.json(await r.json());
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PlusVibe proxy: campaigns ──────────────────────────────
  router.get('/api/pv/campaigns', async (req, res) => {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    try {
      const r = await fetch(`https://api.plusvibe.ai/api/v1/campaigns?workspace_id=${workspace_id}`, {
        headers: { 'x-api-key': PLUSVIBE_KEY },
      });
      if (!r.ok) throw new Error(`PlusVibe ${r.status}`);
      res.json(await r.json());
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PlusVibe proxy: workspace leads (public — no auth needed for internal proxy) ──
  router.get('/api/pv/workspace-leads', async (req, res) => {
    const { workspace_id, page, limit } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    try {
      const qs = new URLSearchParams({ workspace_id, page: page || '1', limit: limit || '100' });
      const r = await fetch(`https://api.plusvibe.ai/api/v1/leads?${qs}`, {
        headers: { 'x-api-key': PLUSVIBE_KEY },
      });
      if (!r.ok) throw new Error(`PlusVibe ${r.status}`);
      res.json(await r.json());
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PlusVibe proxy: push contacts to campaign ──────────────
  router.post('/api/pv/push-contacts', async (req, res) => {
    const { workspace_id, campaign_id, contacts } = req.body || {};
    if (!workspace_id || !campaign_id || !Array.isArray(contacts))
      return res.status(400).json({ error: 'workspace_id, campaign_id, and contacts required' });
    try {
      const r = await fetch(`https://api.plusvibe.ai/api/v1/campaigns/${campaign_id}/leads?workspace_id=${workspace_id}`, {
        method: 'POST',
        headers: { 'x-api-key': PLUSVIBE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: contacts }),
      });
      const json = await r.json();
      if (!r.ok) return res.status(r.status).json(json);
      res.json(json);
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Campaign filters (Postgres) ────────────────────────────
  router.get('/api/campaign-filters', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json([]);
      const { workspace_id, campaign_id } = req.query;
      let query = 'SELECT * FROM campaign_filters';
      const params = [];
      const conditions = [];
      if (workspace_id) { conditions.push(`workspace_id = $${params.length + 1}`); params.push(workspace_id); }
      if (campaign_id)  { conditions.push(`campaign_id  = $${params.length + 1}`); params.push(campaign_id); }
      if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
      query += ' ORDER BY saved_at DESC';
      const { rows } = await pgdb.query(query, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/campaign-filters', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      const { workspace_id, campaign_id, filters } = req.body || {};
      if (!workspace_id || !campaign_id) return res.status(400).json({ error: 'workspace_id and campaign_id required' });
      await pgdb.query(`
        INSERT INTO campaign_filters (workspace_id, campaign_id, filters, saved_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (workspace_id, campaign_id) DO UPDATE SET filters=$3, saved_at=NOW()
      `, [workspace_id, campaign_id, JSON.stringify(filters || {})]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/campaign-filters/:workspace_id/:campaign_id', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      await pgdb.query(
        'DELETE FROM campaign_filters WHERE workspace_id=$1 AND campaign_id=$2',
        [req.params.workspace_id, req.params.campaign_id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRouter;
