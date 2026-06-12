'use strict';
/**
 * routes/diagnostics.js
 * Diagnostics + Intelligence endpoints:
 *   GET  /api/diagnostics/health
 *   POST /api/diagnostics/scan-factors
 *   GET  /api/diagnostics/external-factors
 *   POST /api/diagnostics/log-external-factor
 *   GET  /api/diagnostics/signals
 *   GET  /api/intelligence/logs
 *   GET  /api/intelligence/patterns
 *   GET  /api/intelligence/ws-stats
 *   GET  /api/intelligence/perf-sample
 *   GET  /api/intelligence/debug
 *   POST /api/intelligence/deep-backfill
 *   POST /api/intelligence/reset
 *   POST /api/intelligence/run-today
 *
 * Extracted from server.js lines ~5448–5808.
 * Mounted with: app.use('/', diagnosticsRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.Sentry
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 * @param {Function} ctx.pvFetch
 * @param {Function} ctx.serverDateString
 * @param {Function} ctx.activePerformanceWorkspaces
 * @param {Function} ctx.autoDetectUKExternalFactors
 */
function makeRouter(ctx) {
  const {
    Sentry,
    requireSession, requireAdmin,
    pvFetch, serverDateString,
    activePerformanceWorkspaces, autoDetectUKExternalFactors,
  } = ctx;

  const router = express.Router();

  // ── Infrastructure health snapshot ────────────────────────
  router.get('/api/diagnostics/health', requireSession, (req, res) => {
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    try {
      const { logSignal } = require('./api-diagnostics');
      logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_mb',
        metric_value: Math.round(mem.heapUsed / 1024 / 1024), unit: 'MB' });
      logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_pct',
        metric_value: heapPct, unit: '%' });
    } catch(_) {}
    res.json({
      timestamp: new Date(),
      memory: {
        heap_used_mb:  Math.round(mem.heapUsed  / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        rss_mb:        Math.round(mem.rss       / 1024 / 1024),
        heap_pct:      heapPct,
      },
      uptime_s: Math.round(process.uptime()),
      status: heapPct > 85 ? 'critical' : heapPct > 70 ? 'warning' : 'ok',
    });
  });

  // ── Scan UK external factors ───────────────────────────────
  router.post('/api/diagnostics/scan-factors', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      await autoDetectUKExternalFactors(pgdb);
      const today = new Date().toISOString().split('T')[0];
      const r = await pgdb.query(
        `SELECT * FROM diagnostic_external_factors WHERE date = $1 ORDER BY created_at DESC`, [today]
      );
      res.json({ ok: true, factors: r.rows, date: today });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── List external factors ─────────────────────────────────
  router.get('/api/diagnostics/external-factors', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { days = 30 } = req.query;
    try {
      const r = await pgdb.query(
        `SELECT id, date::text, workspace_id, factor_type, description, severity, created_by, created_at
         FROM diagnostic_external_factors
         WHERE date > CURRENT_DATE - ($1 || ' days')::INTERVAL
         ORDER BY date DESC`,
        [days]
      );
      res.json({ factors: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Log external factor ───────────────────────────────────
  router.post('/api/diagnostics/log-external-factor', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { date, factor_type, description, severity = 'medium', regions_affected, expected_impact } = req.body;
    if (!date || !factor_type) return res.status(400).json({ error: 'date and factor_type are required' });
    try {
      const r = await pgdb.query(
        `INSERT INTO diagnostic_external_factors
           (date, factor_type, description, severity, regions_affected, expected_impact, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, date::text, factor_type, description, severity`,
        [date, factor_type, description || '', severity,
         regions_affected || null, expected_impact || null,
         'operator']
      );
      res.json({ factor: r.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Diagnostic signals ────────────────────────────────────
  router.get('/api/diagnostics/signals', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id, days = 30, signal_type } = req.query;
    try {
      const conditions = ['timestamp > NOW() - ($1 || \' days\')::INTERVAL'];
      const params = [days];
      if (workspace_id) { conditions.push(`workspace_id = $${params.length + 1}`); params.push(workspace_id); }
      if (signal_type)  { conditions.push(`signal_type = $${params.length + 1}`);  params.push(signal_type);  }
      const rows = await pgdb.query(`
        SELECT DATE(timestamp)::text AS date, signal_type, metric_key,
               ROUND(AVG(metric_value)::numeric, 2) AS avg_value,
               MAX(metric_value) AS max_value, MIN(metric_value) AS min_value,
               COUNT(*) AS sample_count,
               MAX(status) AS status
        FROM diagnostic_signals
        WHERE ${conditions.join(' AND ')}
        GROUP BY DATE(timestamp), signal_type, metric_key
        ORDER BY date DESC, signal_type, metric_key
      `, params);
      res.json({ signals: rows.rows, days: Number(days) });
    } catch (err) {
      console.error('[diagnostics] signals query failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Intelligence: daily logs ──────────────────────────────
  router.get('/api/intelligence/logs', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { days = 90 } = req.query;
    try {
      const r = await pgdb.query(`
        SELECT date::text, performance_tier, reply_rate, bounce_rate, warmup_pct,
               api_health, key_signals, correlated_patterns, intelligence_notes
        FROM daily_intelligence_logs
        WHERE date > CURRENT_DATE - ($1 || ' days')::INTERVAL
        ORDER BY date DESC
      `, [days]);
      res.json({ logs: r.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Intelligence: pattern library ─────────────────────────
  router.get('/api/intelligence/patterns', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      const r = await pgdb.query(`
        SELECT pattern_type, pattern_value, avg_reply_rate, sample_size,
               correlation_strength, last_updated::text
        FROM performance_patterns
        WHERE sample_size >= 3
        ORDER BY ABS(correlation_strength) DESC, sample_size DESC
      `);
      res.json({ patterns: r.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Intelligence: workspace stats ─────────────────────────
  router.get('/api/intelligence/ws-stats', requireAdmin, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      const r = await pgdb.query(`
        SELECT workspace_id, workspace_name,
          (stats->>'reply_rate_30d')::numeric  AS rr_30d,
          (stats->>'bounce_rate_30d')::numeric AS br_30d,
          (stats->>'sent_30d')::numeric        AS sent_30d,
          (stats->>'replied_30d')::numeric     AS replied_30d
        FROM workspace_stats
        WHERE stats IS NOT NULL
        ORDER BY (stats->>'sent_30d')::numeric DESC NULLS LAST
      `);
      res.json({ workspaces: r.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Intelligence: perf-sample ─────────────────────────────
  router.get('/api/intelligence/perf-sample', requireAdmin, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      const sample = await pgdb.query(`
        SELECT ws_id, date, data FROM perf_cache_daily
        WHERE COALESCE((data->>'sent')::numeric, 0) > 0
        ORDER BY date DESC LIMIT 3
      `);
      const agg = await pgdb.query(`
        SELECT date,
          SUM((data->>'sent')::numeric)    AS sent,
          SUM((data->>'replies')::numeric) AS replies,
          SUM((data->>'bounces')::numeric) AS bounces,
          jsonb_object_keys(data) AS keys
        FROM perf_cache_daily
        WHERE date = (SELECT MAX(date) FROM perf_cache_daily)
        GROUP BY date, jsonb_object_keys(data)
        LIMIT 20
      `);
      res.json({ sample: sample.rows, field_keys: agg.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Intelligence: debug view ──────────────────────────────
  router.get('/api/intelligence/debug', requireAdmin, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      const ee = await pgdb.query(`
        SELECT workspace_id, DATE(event_at)::text as date,
          COUNT(*) FILTER (WHERE event_type='sent')   as sends,
          COUNT(*) FILTER (WHERE event_type='reply')  as replies,
          ROUND(100.0 * COUNT(*) FILTER (WHERE event_type='reply') /
            NULLIF(COUNT(*) FILTER (WHERE event_type='sent'),0), 1) as rr_pct
        FROM email_events
        WHERE event_at > NOW() - INTERVAL '7 days'
        GROUP BY workspace_id, DATE(event_at)
        ORDER BY date DESC, sends DESC
        LIMIT 40
      `);
      const logs = await pgdb.query(`
        SELECT date::text, performance_tier, reply_rate
        FROM daily_intelligence_logs ORDER BY date DESC LIMIT 10
      `);
      res.json({ email_events: ee.rows, intelligence_logs: logs.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Intelligence: deep backfill ───────────────────────────
  router.post('/api/intelligence/deep-backfill', requireAdmin, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const daysBack = Math.min(parseInt(req.body?.days || 365, 10), 730);
    try {
      const { ensureUniqueConstraint, classifyTier } = require('./api-intelligence');
      await ensureUniqueConstraint(pgdb);

      const end   = serverDateString(new Date());
      const start = serverDateString(new Date(Date.now() - daysBack * 86400000));

      const workspaces = await activePerformanceWorkspaces();
      const wsIds = workspaces.map(w => w.id);

      const byDate = {};
      const CONC = 6;
      for (let i = 0; i < wsIds.length; i += CONC) {
        await Promise.allSettled(wsIds.slice(i, i + CONC).map(async wsId => {
          try {
            const raw = await pvFetch(`/account/email-stats?workspace_id=${wsId}&start_date=${start}&end_date=${end}`);
            const chart = Array.isArray(raw) ? raw : (raw?.chart || []);
            for (const row of chart) {
              const date = (row.date || row.day || '').slice(0, 10);
              if (!date) continue;
              if (!byDate[date]) byDate[date] = { sent: 0, replies: 0, bounces: 0 };
              byDate[date].sent    += row.total_sent_count   || 0;
              byDate[date].replies += row.total_reply_count  || 0;
              byDate[date].bounces += row.total_bounce_count || 0;
            }
          } catch (e) { /* skip failed workspace */ }
        }));
      }

      await pgdb.query(`TRUNCATE daily_intelligence_logs`);
      await pgdb.query(`TRUNCATE performance_patterns`);
      const { classifyTier: _ct, runDailyIntelligence, updatePerformancePatterns } = require('./api-intelligence');

      let seeded = 0;
      const dates = Object.keys(byDate).sort();
      for (const date of dates) {
        const d = byDate[date];
        if (d.sent < 200) continue;
        const rr   = Math.round((d.replies / d.sent) * 10000) / 100;
        const br   = Math.round((d.bounces / d.sent) * 10000) / 100;
        const tier = classifyTier(rr, br, null, d.sent);
        const dow  = new Date(date + 'T12:00:00Z').getDay();
        const dayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dow];
        const signals = { rr_tier: tier, bounce_health: br < 3 ? 'clean' : br < 6 ? 'ok' : br < 10 ? 'elevated' : 'high',
          send_volume: d.sent >= 1000 ? 'high' : d.sent >= 300 ? 'medium' : 'low', day_of_week: dayName, has_external_factor: false };
        const notes = `${tier === 'excellent' ? 'Strong' : tier === 'good' ? 'Good' : tier === 'fair' ? 'Average' : 'Poor'} day — ${rr}% reply rate (${d.sent} sends).`;
        try {
          await pgdb.query(`
            INSERT INTO daily_intelligence_logs
              (date, workspace_id, performance_tier, reply_rate, bounce_rate, key_signals, correlated_patterns, intelligence_notes)
            VALUES ($1,'global',$2,$3,$4,$5,$6,$7)
            ON CONFLICT (date, workspace_id) DO UPDATE SET
              performance_tier=EXCLUDED.performance_tier, reply_rate=EXCLUDED.reply_rate,
              bounce_rate=EXCLUDED.bounce_rate, key_signals=EXCLUDED.key_signals,
              correlated_patterns=EXCLUDED.correlated_patterns, intelligence_notes=EXCLUDED.intelligence_notes
          `, [date, tier, rr, br, JSON.stringify(signals), '[]', notes]);
          seeded++;
        } catch(e) { /* skip duplicate */ }
      }

      res.json({ ok: true, workspaces_fetched: workspaces.length, days_seeded: seeded });
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Intelligence: reset ───────────────────────────────────
  router.post('/api/intelligence/reset', requireAdmin, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      await pgdb.query(`TRUNCATE daily_intelligence_logs`);
      await pgdb.query(`TRUNCATE performance_patterns`);
      const { backfillIntelligenceLogs } = require('./api-intelligence');
      await backfillIntelligenceLogs(pgdb);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Intelligence: run today ───────────────────────────────
  router.post('/api/intelligence/run-today', requireSession, async (req, res) => {
    const pgdb = req.app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    try {
      const { runDailyIntelligence, updatePerformancePatterns } = require('./api-intelligence');
      const result = await runDailyIntelligence(pgdb);
      await updatePerformancePatterns(pgdb);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRouter;
