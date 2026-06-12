'use strict';
/**
 * routes/stats.js
 * Performance / stats cache endpoints:
 *   GET  /api/performance/agency-cache
 *   POST /api/stats/refresh
 *   GET  /api/stats/summary
 *   GET  /api/verify-split
 *   GET  /api/metrics, /api/metrics/:workspaceId
 *   POST /api/metrics/refresh
 *
 * These routes depend heavily on in-memory caches (performanceCache, revenueCache)
 * and helper functions that remain in server.js. They are wired via ctx.
 *
 * Extracted from server.js.
 * Mounted with: app.use('/', statsRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {object}   ctx.Sentry
 * @param {object}   ctx.apiCache
 * @param {Function} ctx.requireSession
 * @param {object}   ctx.performanceCache
 * @param {Function} ctx.warmPerformanceCache
 * @param {Function} ctx.buildRequestedPerformanceCache
 * @param {Function} ctx.hasReadyPerformanceCache
 * @param {Function} ctx.readReadyPerformanceCache
 * @param {Function} ctx.computeWorkspaceStatsForRange
 * @param {Function} ctx.serverDateList
 * @param {Function} ctx.serverDateString
 * @param {object}   ctx.EMPTY_PERF_AGG
 * @param {number}   ctx.PERF_TODAY_TTL_MS
 * @param {number}   ctx.PERF_OLD_TTL_MS
 * @param {Function} ctx.getPerformanceWarmPromise  - getter for current warm promise
 * @param {Function} ctx.setPerformanceWarmPromise  - setter to null-out the warm promise
 */
function makeRouter(ctx) {
  const {
    db, Sentry, apiCache,
    requireSession,
    performanceCache,
    warmPerformanceCache, buildRequestedPerformanceCache,
    hasReadyPerformanceCache, readReadyPerformanceCache,
    computeWorkspaceStatsForRange,
    serverDateList, serverDateString,
    EMPTY_PERF_AGG, PERF_TODAY_TTL_MS, PERF_OLD_TTL_MS,
    getPerformanceWarmPromise, setPerformanceWarmPromise,
  } = ctx;

  const router = express.Router();

  // ── Performance agency cache ──────────────────────────────
  router.get('/api/performance/agency-cache', requireSession, async (req, res) => {
    const wsIds = String(req.query.workspace_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const start = String(req.query.start || '');
    const end   = String(req.query.end   || '');
    if (!wsIds.length || !start || !end)
      return res.status(400).json({ error: 'Missing workspace_ids, start, or end' });
    try {
      const dates = serverDateList(start, end);
      if (!hasReadyPerformanceCache(wsIds, dates)) {
        await Promise.race([
          buildRequestedPerformanceCache(wsIds, dates),
          new Promise(resolve => setTimeout(resolve, 12000)),
        ]);
      }
      const { daily, leads } = readReadyPerformanceCache(wsIds, dates);
      if (!performanceCache.warming) setTimeout(warmPerformanceCache, 0);
      res.json({
        daily,
        leads,
        updatedAt: performanceCache.updatedAt,
        version:   performanceCache.version,
        warming:   performanceCache.warming,
        partial:   !hasReadyPerformanceCache(wsIds, dates),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats refresh ─────────────────────────────────────────
  router.post('/api/stats/refresh', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (pgdb) await pgdb.clearPerfCache();
      performanceCache.dailyStats.clear();
      performanceCache.labeledLeads.clear();
      performanceCache.version = 0;
      setPerformanceWarmPromise(null);
      warmPerformanceCache().catch(() => {});
      res.json({ ok: true, message: 'Cache cleared — refreshing from PlusVibe' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats summary ─────────────────────────────────────────
  router.get('/api/stats/summary', requireSession, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const start = String(req.query.start || '');
    const end   = String(req.query.end   || '');
    if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
    const _wsIdsParam = req.query.workspace_ids ? String(req.query.workspace_ids) : '';
    const cacheKey = 'stats_summary_' + JSON.stringify({ start, end, workspace_ids: _wsIdsParam });
    const _cachedSummary = apiCache.get(cacheKey);
    if (_cachedSummary !== undefined) return res.json(_cachedSummary);
    try {
      const clientRows = db.prepare(
        `SELECT workspace_id, workspace_name, client_status FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != ''`
      ).all();
      const filterIds = req.query.workspace_ids ? String(req.query.workspace_ids).split(',').filter(Boolean) : null;
      const activeClients = clientRows.filter(c => {
        if (c.client_status === 'inactive') return false;
        if (filterIds) return filterIds.includes(c.workspace_id);
        return true;
      });
      const wsIds   = activeClients.map(c => c.workspace_id);
      const wsNames = Object.fromEntries(activeClients.map(c => [c.workspace_id, c.workspace_name]));
      const dates   = serverDateList(start, end);

      const today = serverDateString(new Date());
      const wsHasAnyData = {};
      for (const wsId of wsIds) {
        wsHasAnyData[wsId] = dates.some(d => performanceCache.dailyStats.has(`${wsId}|${d}`));
      }
      const anyDataAtAll = performanceCache.dailyStats.size > 0;
      const missing = !anyDataAtAll || wsIds.some(wsId =>
        wsHasAnyData[wsId] && dates.some(date => !performanceCache.dailyStats.has(`${wsId}|${date}`))
      );
      const anyStale = wsIds.some(wsId =>
        wsHasAnyData[wsId] && dates.some(date => {
          const cached = performanceCache.dailyStats.get(`${wsId}|${date}`);
          const ttl = date === today ? PERF_TODAY_TTL_MS : PERF_OLD_TTL_MS;
          return cached && Date.now() - cached.savedAt > ttl;
        })
      );
      const partial = missing;
      if ((missing || anyStale) && !performanceCache.warming) {
        warmPerformanceCache().catch(() => {});
      }

      const wsStats = computeWorkspaceStatsForRange(wsIds, start, end);
      const workspaces = wsIds.map(wsId => ({
        workspace_id: wsId,
        name: wsNames[wsId] || wsId,
        totals: wsStats[wsId].totals,
        series: wsStats[wsId].series,
      })).filter(w => w.totals.sent > 0 || w.totals.leads > 0);

      workspaces.sort((a, b) => b.totals.replies - a.totals.replies);

      const _summaryResult = {
        workspaces, dates, start, end, partial,
        updatedAt: performanceCache.updatedAt,
      };
      if (!partial) apiCache.set(cacheKey, _summaryResult, 60);
      res.json(_summaryResult);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Verify split ──────────────────────────────────────────
  router.get('/api/verify-split', requireSession, async (req, res) => {
    const start = String(req.query.start || '');
    const end   = String(req.query.end   || '');
    if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

      const summaryQ = `
        SELECT
          COALESCE(email_status, 'unknown')                                       AS email_status,
          COUNT(*)::int                                                            AS unique_contacts,
          SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
          COUNT(*) FILTER (WHERE last_reply_at >= $1)::int                        AS replies,
          COUNT(*) FILTER (WHERE bounced_at    >= $1)::int                        AS bounces,
          COUNT(*) FILTER (WHERE marked_as_lead_at >= $1
                              OR (status = 'interested' AND last_reply_at >= $1))::int AS leads
        FROM contacts
        WHERE last_emailed_at >= $1
          AND last_emailed_at < ($2::date + interval '1 day')
        GROUP BY COALESCE(email_status, 'unknown')
        ORDER BY sent DESC
      `;

      const dailyQ = `
        SELECT
          last_emailed_at::date                                                    AS day,
          COALESCE(email_status, 'unknown')                                       AS email_status,
          COUNT(*)::int                                                            AS contacts,
          SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
          COUNT(*) FILTER (WHERE last_reply_at >= last_emailed_at)::int           AS replies,
          COUNT(*) FILTER (WHERE bounced_at    >= last_emailed_at)::int           AS bounces
        FROM contacts
        WHERE last_emailed_at >= $1
          AND last_emailed_at < ($2::date + interval '1 day')
          AND email_status IN ('safe', 'safe_catchall')
        GROUP BY 1, 2
        ORDER BY 1, 2
      `;

      const [{ rows: summary }, { rows: daily }] = await Promise.all([
        pgdb.query(summaryQ, [start, end]),
        pgdb.query(dailyQ,   [start, end]),
      ]);

      res.json({ summary, daily, start, end });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Workspace metrics (workspace_stats table) ─────────────
  router.post('/api/metrics/refresh', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      // Delegated to server.js computeWorkspaceStats machinery via the
      // full refresh triggered on the Performance page refresh.
      warmPerformanceCache().catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/metrics', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      const { rows } = await pgdb.query(
        `SELECT workspace_id, workspace_name, stats, updated_at FROM workspace_stats ORDER BY workspace_name`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/metrics/:workspaceId', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      const { rows } = await pgdb.query(
        `SELECT workspace_id, workspace_name, stats, updated_at FROM workspace_stats WHERE workspace_id = $1`,
        [req.params.workspaceId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Workspace stats not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRouter;
