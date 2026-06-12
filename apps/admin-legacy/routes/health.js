'use strict';
/**
 * routes/health.js
 * Client Health & AI Briefing endpoints:
 *   GET  /api/health/clients
 *   GET  /api/health/clients/:wsId
 *   GET  /api/health/copy-alerts
 *   POST /api/health/copy-alerts/:id/dismiss
 *   POST /api/health/generate-variants
 *   GET  /api/health/ai-test
 *   POST /api/health/refresh
 *   POST /api/health/evaluate-outcomes
 *   POST /api/health/actions/:id/complete
 *   POST /api/health/actions/:id/uncomplete
 *   POST /api/health/actions/:id/dismiss
 *
 * Extracted from server.js lines ~5808–6260.
 * Mounted with: app.use('/', healthRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {string}   ctx.ANTHROPIC_API_KEY
 * @param {string}   ctx.ANTHROPIC_MODEL
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 * @param {Function} ctx.decodeSession
 * @param {Function} ctx.visibleWorkspaceIds
 * @param {Function} ctx.buildHealthSnapshot
 * @param {Function} ctx.refreshAllClientHealth
 * @param {Function} ctx.evaluateActionOutcomes
 * @param {Function} ctx.callClaude   - from slack-slash or health-briefing module
 */
function makeRouter(ctx) {
  const {
    db,
    ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
    requireSession, requireAdmin, decodeSession,
    visibleWorkspaceIds,
    buildHealthSnapshot, refreshAllClientHealth, evaluateActionOutcomes,
    callClaude,
  } = ctx;

  const router = express.Router();

  // ── List clients with latest snapshot ────────────────────
  router.get('/api/health/clients', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const visible = visibleWorkspaceIds(req);
    if (!visible?.length) return res.json({ clients: [], generated_at: null });
    const wsIds = visible.map(v => v.workspace_id);

    try {
      const r = await pgdb.query(`
        SELECT DISTINCT ON (workspace_id)
               workspace_id, snapshot_date, health_score, health_band,
               sent_7d, replies_7d, bounces_7d, leads_7d,
               reply_rate_7d, reply_rate_baseline, bounce_rate_7d,
               reply_rate_gmail_7d, reply_rate_outlook_7d,
               mailbox_total, mailbox_unhealthy, domain_unhealthy, copy_alerts_open,
               lead_target_monthly, leads_mtd, leads_expected_mtd, pace_pct,
               ai_briefing, ai_briefing_source, ai_actions, signals
          FROM client_health_snapshots
         WHERE workspace_id = ANY($1::text[])
         ORDER BY workspace_id, snapshot_date DESC
      `, [wsIds]);

      const byWs = Object.fromEntries(r.rows.map(row => [row.workspace_id, row]));

      const actsRes = await pgdb.query(`
        SELECT id, workspace_id, snapshot_date, label, kind, payload, rationale,
               priority, target_metric, target_direction, completed_at, completed_by,
               outcome, outcome_notes, outcome_at, baseline_value, followup_value
          FROM health_actions
         WHERE workspace_id = ANY($1::text[])
           AND dismissed_at IS NULL
           AND snapshot_date = (
             SELECT MAX(snapshot_date) FROM health_actions ha2
              WHERE ha2.workspace_id = health_actions.workspace_id
           )
         ORDER BY priority ASC, id ASC
      `, [wsIds]);
      const actionsByWs = {};
      for (const a of actsRes.rows) {
        (actionsByWs[a.workspace_id] = actionsByWs[a.workspace_id] || []).push(a);
      }

      const clients = visible.map(v => {
        const snap = byWs[v.workspace_id] || null;
        return {
          workspace_id: v.workspace_id,
          workspace_name: v.workspace_name,
          campaign_manager: v.campaign_manager,
          snapshot: snap,
          actions: actionsByWs[v.workspace_id] || [],
          has_data: !!snap,
        };
      });

      const bandOrder = { red: 0, yellow: 1, green: 2 };
      clients.sort((a, b) => {
        const ba = a.snapshot ? bandOrder[a.snapshot.health_band] ?? 3 : 4;
        const bb = b.snapshot ? bandOrder[b.snapshot.health_band] ?? 3 : 4;
        if (ba !== bb) return ba - bb;
        return (a.snapshot?.health_score ?? 100) - (b.snapshot?.health_score ?? 100);
      });

      res.json({
        clients,
        generated_at: r.rows[0]?.snapshot_date || null,
        ai_enabled: !!ANTHROPIC_API_KEY,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Per-client detail ────────────────────────────────────
  router.get('/api/health/clients/:wsId', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const visible = visibleWorkspaceIds(req);
    const wsId = req.params.wsId;
    const meta = (visible || []).find(v => v.workspace_id === wsId);
    if (!meta) return res.status(404).json({ error: 'Not found or not authorized' });

    try {
      const [latest, history, alerts] = await Promise.all([
        pgdb.query(`
          SELECT * FROM client_health_snapshots
           WHERE workspace_id=$1 ORDER BY snapshot_date DESC LIMIT 1
        `, [wsId]),
        pgdb.query(`
          SELECT snapshot_date, health_score, reply_rate_7d, bounce_rate_7d
            FROM client_health_snapshots
           WHERE workspace_id=$1
           ORDER BY snapshot_date DESC LIMIT 14
        `, [wsId]),
        pgdb.query(`
          SELECT ta.*, t.subject AS template_subject, t.body_excerpt AS template_excerpt
            FROM template_alerts ta
            LEFT JOIN templates t ON t.content_hash = ta.content_hash
           WHERE ta.workspace_id=$1
             AND ta.dismissed_at IS NULL
             AND ta.resolved_at IS NULL
           ORDER BY
             CASE ta.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             ta.created_at DESC
        `, [wsId]),
      ]);

      res.json({
        workspace_id: wsId,
        workspace_name: meta.workspace_name,
        campaign_manager: meta.campaign_manager,
        snapshot: latest.rows[0] || null,
        history: history.rows.reverse(),
        alerts: alerts.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Copy alerts ───────────────────────────────────────────
  router.get('/api/health/copy-alerts', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const visible = visibleWorkspaceIds(req);
    if (!visible?.length) return res.json({ alerts: [] });
    const wsIds = visible.map(v => v.workspace_id);
    const wsName = Object.fromEntries(visible.map(v => [v.workspace_id, v.workspace_name]));

    try {
      const r = await pgdb.query(`
        SELECT ta.*, t.subject AS template_subject, t.body_excerpt AS template_excerpt
          FROM template_alerts ta
          LEFT JOIN templates t ON t.content_hash = ta.content_hash
         WHERE ta.workspace_id = ANY($1::text[])
           AND ta.dismissed_at IS NULL
           AND ta.resolved_at IS NULL
         ORDER BY
           CASE ta.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           ta.created_at DESC
         LIMIT 100
      `, [wsIds]);

      const alerts = r.rows.map(a => ({
        ...a,
        workspace_name: wsName[a.workspace_id] || a.workspace_id,
      }));
      res.json({ alerts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dismiss copy alert ────────────────────────────────────
  router.post('/api/health/copy-alerts/:id/dismiss', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const visible = visibleWorkspaceIds(req);
    const wsIds = (visible || []).map(v => v.workspace_id);
    try {
      const r = await pgdb.query(`
        UPDATE template_alerts SET dismissed_at = NOW()
         WHERE id=$1 AND workspace_id = ANY($2::text[])
         RETURNING id
      `, [req.params.id, wsIds]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found or not authorized' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Generate AI variants ──────────────────────────────────
  router.post('/api/health/generate-variants', requireSession, async (req, res) => {
    const { alert_id, count } = req.body || {};
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured — set ANTHROPIC_API_KEY' });
    const visible = visibleWorkspaceIds(req);
    const wsIds = (visible || []).map(v => v.workspace_id);

    try {
      const r = await pgdb.query(`
        SELECT ta.*, t.subject AS template_subject, t.body AS template_body
          FROM template_alerts ta
          LEFT JOIN templates t ON t.content_hash = ta.content_hash
         WHERE ta.id=$1 AND ta.workspace_id = ANY($2::text[])
         LIMIT 1
      `, [alert_id, wsIds]);
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: 'Alert not found' });

      const exemplars = await pgdb.query(`
        SELECT t.subject, COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply'))::int AS replies,
               COUNT(*) FILTER (WHERE ee.event_type='sent')::int AS sent
          FROM email_events ee
          JOIN templates t ON t.content_hash = ee.content_hash
         WHERE ee.workspace_id=$1
           AND ee.event_at >= NOW() - INTERVAL '60 days'
           AND t.subject IS NOT NULL AND t.subject <> ''
         GROUP BY t.subject
        HAVING COUNT(*) FILTER (WHERE ee.event_type='sent') >= 200
         ORDER BY (COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')))::numeric
                / NULLIF(COUNT(*) FILTER (WHERE ee.event_type='sent'),0) DESC
         LIMIT 5
      `, [row.workspace_id]);

      const system = `You are an expert cold-email copywriter. The user gives you ONE subject line that has decayed (provider profiling, fatigue, or over-use). You rewrite it ${count || 5} ways. Each rewrite must:
- Preserve the underlying ask / intent of the original
- Use a DIFFERENT structural pattern (not just word swaps — change the shape: question vs statement, length, opening word, presence/absence of merge tags)
- Stay under 60 characters
- Avoid sounding like marketing (no exclamation points, no "Quick", no "Just", no "I noticed", no power words)
- Be plausible coming from a human one-to-one email

Output STRICT JSON only:
{"variants": ["subject 1", "subject 2", ...]}`;

      const user = JSON.stringify({
        decayed_subject: row.template_subject || '(unknown — only the body is decayed)',
        current_body_excerpt: String(row.template_body || '').slice(0, 600),
        alert_type: row.alert_type,
        lifetime_sends: row.lifetime_sends,
        reply_rate_now: row.reply_rate_current,
        reply_rate_was: row.reply_rate_baseline,
        top_performing_subjects_this_client: exemplars.rows.map(e => e.subject),
      });

      if (process.env.DISABLE_AI_FEATURES === '1') return res.status(503).json({ error: 'AI features temporarily disabled' });
      const out = await callClaude({ system, user, maxTokens: 600, expectJson: true });
      if (!out?.variants) return res.status(502).json({ error: 'AI returned no variants' });
      res.json({ variants: out.variants, alert: {
        campaign_name: row.campaign_name, step: row.step, variant: row.variant,
      } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI connectivity test ──────────────────────────────────
  router.get('/api/health/ai-test', requireAdmin, async (req, res) => {
    const key = ANTHROPIC_API_KEY;
    if (!key) return res.json({
      key_present: false,
      model: ANTHROPIC_MODEL,
      status: 'no_key',
      hint: 'Set ANTHROPIC_API_KEY in your env / Easypanel and restart.',
    });
    const masked = { first: key.slice(0, 14), last: key.slice(-8), length: key.length };
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'Say "ok".' }],
        }),
      });
      const body = await r.text();
      if (r.ok) {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        return res.json({
          key_present: true, masked, model: ANTHROPIC_MODEL, status: 'ok',
          sample_response: parsed?.content?.[0]?.text || '(empty)',
        });
      }
      let error = body.slice(0, 300);
      try { error = JSON.parse(body)?.error?.message || error; } catch {}
      res.json({
        key_present: true, masked, model: ANTHROPIC_MODEL,
        status: 'api_error', http_status: r.status, error,
        hint: r.status === 401
          ? 'Key rejected by Anthropic. Check for copy-paste corruption.'
          : r.status === 404
            ? `Model "${ANTHROPIC_MODEL}" not available. Try different ANTHROPIC_MODEL.`
            : 'Inspect "error" above for details.',
      });
    } catch (err) {
      res.json({ key_present: true, masked, model: ANTHROPIC_MODEL, status: 'network_error', error: err.message });
    }
  });

  // ── Force refresh all/one health snapshot ─────────────────
  router.post('/api/health/refresh', requireAdmin, async (req, res) => {
    const { workspace_id } = req.body || {};
    try {
      if (workspace_id) {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const c = db.prepare('SELECT workspace_id, workspace_name FROM clients WHERE workspace_id=?').get(workspace_id);
        if (!c) return res.status(404).json({ error: 'Workspace not found' });
        await evaluateActionOutcomes().catch(() => {});
        const out = await buildHealthSnapshot(c.workspace_id, c.workspace_name);
        return res.json({ ok: true, snapshot: out });
      }
      refreshAllClientHealth().catch(err => console.error('[health] manual refresh:', err));
      res.json({ ok: true, started: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Evaluate action outcomes ──────────────────────────────
  router.post('/api/health/evaluate-outcomes', requireAdmin, async (req, res) => {
    try {
      const out = await evaluateActionOutcomes();
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Complete action ───────────────────────────────────────
  router.post('/api/health/actions/:id/complete', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const s = decodeSession(req);
    const who = s?.name || 'Admin';
    const visible = visibleWorkspaceIds(req);
    const wsIds = (visible || []).map(v => v.workspace_id);

    try {
      const aRes = await pgdb.query(`
        SELECT a.id, a.workspace_id, a.target_metric, a.snapshot_date
          FROM health_actions a
         WHERE a.id = $1 AND a.workspace_id = ANY($2::text[])
           AND a.completed_at IS NULL AND a.dismissed_at IS NULL
         LIMIT 1
      `, [req.params.id, wsIds]);
      const act = aRes.rows[0];
      if (!act) return res.status(404).json({ error: 'Action not found, already done, or not authorized' });

      let baseline = null;
      if (act.target_metric) {
        const sRes = await pgdb.query(
          `SELECT ${act.target_metric.replace(/[^a-z0-9_]/gi,'')} AS v
             FROM client_health_snapshots
            WHERE workspace_id=$1 ORDER BY snapshot_date DESC LIMIT 1`,
          [act.workspace_id]
        );
        baseline = sRes.rows[0]?.v ?? null;
      }

      await pgdb.query(`
        UPDATE health_actions
           SET completed_at = CURRENT_TIMESTAMP,
               completed_by = $1,
               baseline_value = $2
         WHERE id = $3
      `, [who, baseline, req.params.id]);

      res.json({ ok: true, completed_by: who, baseline_value: baseline });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Uncomplete action ─────────────────────────────────────
  router.post('/api/health/actions/:id/uncomplete', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const visible = visibleWorkspaceIds(req);
    const wsIds = (visible || []).map(v => v.workspace_id);
    try {
      const r = await pgdb.query(`
        UPDATE health_actions
           SET completed_at = NULL, completed_by = NULL, baseline_value = NULL,
               followup_value = NULL, outcome = NULL, outcome_at = NULL,
               outcome_notes = NULL
         WHERE id=$1 AND workspace_id = ANY($2::text[]) AND completed_at IS NOT NULL
        RETURNING id
      `, [req.params.id, wsIds]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found or not completed' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dismiss action ────────────────────────────────────────
  router.post('/api/health/actions/:id/dismiss', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const s = decodeSession(req);
    const who = s?.name || 'Admin';
    const reason = String(req.body?.reason || '').slice(0, 200);
    const visible = visibleWorkspaceIds(req);
    const wsIds = (visible || []).map(v => v.workspace_id);
    try {
      const r = await pgdb.query(`
        UPDATE health_actions
           SET dismissed_at = CURRENT_TIMESTAMP,
               dismissed_by = $1,
               dismissed_reason = $2
         WHERE id=$3 AND workspace_id = ANY($4::text[])
           AND completed_at IS NULL AND dismissed_at IS NULL
        RETURNING id
      `, [who, reason || null, req.params.id, wsIds]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found or already actioned' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRouter;
