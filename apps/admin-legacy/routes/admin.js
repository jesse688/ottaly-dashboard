'use strict';
/**
 * routes/admin.js
 * /api/admin/* routes: managers CRUD, payslips, page-visibility,
 * nav-settings, commission payments/adjustments, snooze-clear,
 * workload, clients CRUD, default-commission, and my-clients.
 *
 * Extracted from server.js.
 * Mounted with: app.use('/', adminRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {object}   ctx.bcrypt
 * @param {object}   ctx.Sentry
 * @param {object}   ctx.apiCache
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 * @param {Function} ctx.decodeSession
 * @param {Function} ctx.refreshRevenueCache
 * @param {Function} ctx.refreshCampaignCache
 */
function makeRouter(ctx) {
  const {
    db, bcrypt, Sentry, apiCache,
    requireSession, requireAdmin, decodeSession,
    refreshRevenueCache, refreshCampaignCache,
  } = ctx;

  const router = express.Router();

  // ── Manager management (admin only) ──────────────────────
  router.get('/api/admin/managers', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    res.json(db.prepare('SELECT id, name, commission_rate, base_salary, created_at FROM managers ORDER BY name').all());
  });

  router.put('/api/admin/managers/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { commission_rate, base_salary } = req.body || {};
    if (commission_rate == null && base_salary == null)
      return res.status(400).json({ error: 'Nothing to update' });
    const updates = [];
    const params  = [];
    if (commission_rate != null) { updates.push('commission_rate=?'); params.push(parseFloat(commission_rate) || 0); }
    if (base_salary     != null) { updates.push('base_salary=?');     params.push(parseFloat(base_salary)     || 0); }
    params.push(req.params.id);
    db.prepare(`UPDATE managers SET ${updates.join(',')} WHERE id=?`).run(...params);
    res.json({ ok: true });
  });

  router.post('/api/admin/managers', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name, password } = req.body || {};
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    try {
      db.prepare('INSERT INTO managers (name, password_hash) VALUES (?,?)')
        .run(name.trim(), bcrypt.hashSync(password, 10));
      res.json({ ok: true });
    } catch { res.status(400).json({ error: 'Name already exists' }); }
  });

  router.put('/api/admin/managers/:id/password', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    db.prepare('UPDATE managers SET password_hash=? WHERE id=?')
      .run(bcrypt.hashSync(password, 10), req.params.id);
    res.json({ ok: true });
  });

  router.delete('/api/admin/managers/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    db.prepare('DELETE FROM managers WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Payslips ──────────────────────────────────────────────
  router.post('/api/admin/payslips', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      const { manager_name, month, filename, mimetype, data } = req.body || {};
      if (!manager_name || !month || !data) return res.status(400).json({ error: 'manager_name, month and data required' });
      await pgdb.upsertPayslip(manager_name, month, filename || 'payslip.pdf', mimetype || 'application/pdf', data);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/admin/payslips', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json([]);
      res.json(await pgdb.listAllPayslips());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/api/admin/payslips/:id', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      await pgdb.deletePayslip(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Manager fetches their own payslip for a given month
  router.get('/api/payslips/:month', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(404).json({ error: 'Not found' });
      const s = decodeSession(req);
      const name = s?.name || '';
      const row = await pgdb.getPayslip(name, req.params.month);
      if (!row) return res.status(404).json({ error: 'No payslip for this month' });
      const buf = Buffer.from(row.data, 'base64');
      res.setHeader('Content-Type', row.mimetype);
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
      res.send(buf);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/payslips/:month/meta', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json({ exists: false });
      const s = decodeSession(req);
      const row = await pgdb.getPayslip(s?.name || '', req.params.month);
      res.json(row ? { exists: true, filename: row.filename, uploaded_at: row.uploaded_at } : { exists: false });
    } catch (err) { res.json({ exists: false }); }
  });

  // ── Page visibility ──────────────────────────────────────
  router.get('/api/admin/page-visibility', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json({});
      const val = await pgdb.getSetting('manager_page_visibility', {});
      res.json(val);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/page-visibility', requireAdmin, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
      await pgdb.setSetting('manager_page_visibility', req.body || {});
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/nav-settings', requireSession, async (req, res) => {
    try {
      const pgdb = req.app.locals.pgDb;
      if (!pgdb) return res.json({ pageVisibility: {} });
      const val = await pgdb.getSetting('manager_page_visibility', {});
      res.json({ pageVisibility: val });
    } catch (err) { res.json({ pageVisibility: {} }); }
  });

  // ── Clear snoozes ────────────────────────────────────────
  router.post('/api/admin/clear-snoozes', requireSession, async (req, res) => {
    try {
      const dbPg = req.app.locals.pgDb;
      if (!dbPg) return res.status(503).json({ error: 'Postgres not available' });
      const r = await dbPg.query(`
        UPDATE contacts
           SET snoozed_verticals = '[]'::jsonb,
               reply_notes = NULL,
               updated_at = CURRENT_TIMESTAMP
         WHERE (snoozed_verticals IS NOT NULL AND snoozed_verticals <> '[]'::jsonb)
            OR reply_notes IS NOT NULL
      `);
      console.log(`[admin] cleared snoozes + reply notes on ${r.rowCount} contacts`);
      res.json({ ok: true, updated: r.rowCount });
    } catch (err) {
      console.error('[admin] clear-snoozes', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Commission payments ──────────────────────────────────
  router.get('/api/admin/commission-payments', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    res.json(db.prepare(`
      SELECT manager_name, period_start, period_end, status, payslip_name, payslip_type,
             payslip_data, paid_at, updated_at
      FROM manager_commission_payments
      ORDER BY period_start DESC, manager_name
    `).all());
  });

  router.put('/api/admin/commission-payments', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { manager_name, period_start, period_end, status, payslip_name, payslip_type, payslip_data } = req.body || {};
    if (!manager_name || !period_start || !period_end) return res.status(400).json({ error: 'Missing payment key' });
    const cleanStatus = status === 'paid' ? 'paid' : 'unpaid';
    db.prepare(`
      INSERT INTO manager_commission_payments
        (manager_name, period_start, period_end, status, payslip_name, payslip_type, payslip_data, paid_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='paid' THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT(manager_name, period_start, period_end) DO UPDATE SET
        status=excluded.status,
        payslip_name=excluded.payslip_name,
        payslip_type=excluded.payslip_type,
        payslip_data=excluded.payslip_data,
        paid_at=CASE WHEN excluded.status='paid' THEN COALESCE(manager_commission_payments.paid_at, datetime('now')) ELSE NULL END,
        updated_at=datetime('now')
    `).run(
      manager_name.trim(), period_start, period_end, cleanStatus,
      payslip_name || '', payslip_type || '', payslip_data || '', cleanStatus
    );
    res.json({ ok: true });
  });

  // ── Commission adjustments ───────────────────────────────
  router.get('/api/admin/commission-adjustments', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    res.json(db.prepare(`
      SELECT id, manager_name, label, amount, active, created_at
      FROM manager_commission_adjustments
      ORDER BY active DESC, manager_name, label
    `).all());
  });

  router.post('/api/admin/commission-adjustments', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { manager_name, label, amount } = req.body || {};
    const cleanManager = (manager_name || '').trim();
    const cleanLabel = (label || '').trim();
    const cleanAmount = parseFloat(amount);
    if (!cleanManager || !cleanLabel || !Number.isFinite(cleanAmount)) {
      return res.status(400).json({ error: 'Manager, label and amount are required' });
    }
    db.prepare(`
      INSERT INTO manager_commission_adjustments (manager_name, label, amount, active)
      VALUES (?, ?, ?, 1)
    `).run(cleanManager, cleanLabel, cleanAmount);
    res.json({ ok: true });
  });

  router.put('/api/admin/commission-adjustments/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { manager_name, label, amount, active } = req.body || {};
    const updates = [];
    const vals = [];
    if (manager_name !== undefined) { updates.push('manager_name = ?'); vals.push((manager_name || '').trim()); }
    if (label !== undefined) { updates.push('label = ?'); vals.push((label || '').trim()); }
    if (amount !== undefined) { updates.push('amount = ?'); vals.push(parseFloat(amount) || 0); }
    if (active !== undefined) { updates.push('active = ?'); vals.push(active ? 1 : 0); }
    if (updates.length) {
      db.prepare(`UPDATE manager_commission_adjustments SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    }
    res.json({ ok: true });
  });

  router.delete('/api/admin/commission-adjustments/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    db.prepare('DELETE FROM manager_commission_adjustments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Default commission ────────────────────────────────────
  router.get('/api/admin/default-commission', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const row = db.prepare(`SELECT value FROM app_meta WHERE key='default_commission_rate'`).get();
    res.json({ rate: row ? parseFloat(row.value) : 15 });
  });

  router.post('/api/admin/default-commission', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { rate } = req.body || {};
    const r = parseFloat(rate);
    if (!Number.isFinite(r) || r < 0 || r > 100) return res.status(400).json({ error: 'Invalid rate' });
    db.prepare(`INSERT INTO app_meta (key,value) VALUES ('default_commission_rate',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(r));
    res.json({ ok: true });
  });

  // ── My clients (manager's own list) ──────────────────────
  router.get('/api/my-clients', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const s = decodeSession(req);
    const name = s?.name || '';
    if (!name) return res.json([]);
    const rows = db.prepare(`
      SELECT c.id, c.workspace_id, c.workspace_name, c.client_status,
             cm.commission_rate, cm.assigned_at
      FROM clients c
      JOIN client_managers cm ON cm.client_workspace_id = c.workspace_id
      WHERE LOWER(cm.manager_name) = LOWER(?)
      ORDER BY c.workspace_name
    `).all(name);
    res.json(rows);
  });

  // ── Workload: CM stats ────────────────────────────────────
  router.get('/api/admin/workload/cm-stats', requireSession, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    try {
      const managers = db.prepare('SELECT id, name, commission_rate, base_salary FROM managers ORDER BY name').all();
      const clientManagers = db.prepare(`
        SELECT cm.manager_name, cm.client_workspace_id, cm.commission_rate,
               c.workspace_name, c.client_status, c.price_per_lead
        FROM client_managers cm
        JOIN clients c ON c.workspace_id = cm.client_workspace_id
        ORDER BY cm.manager_name, c.workspace_name
      `).all();
      const clientsByMgr = {};
      for (const cm of clientManagers) {
        if (!clientsByMgr[cm.manager_name]) clientsByMgr[cm.manager_name] = [];
        clientsByMgr[cm.manager_name].push(cm);
      }
      const result = managers.map(m => ({
        ...m,
        clients: clientsByMgr[m.name] || [],
        active_count: (clientsByMgr[m.name] || []).filter(c => c.client_status === 'active').length,
      }));
      res.json(result);
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/workload/recalc', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    // Backfill client_managers from clients.campaign_manager / campaign_manager_2
    try {
      const clients = db.prepare('SELECT workspace_id, campaign_manager, campaign_manager_2, commission_rate FROM clients').all();
      const insert  = db.prepare(`INSERT OR IGNORE INTO client_managers (client_workspace_id, manager_name, commission_rate) VALUES (?, ?, ?)`);
      const tx = db.transaction(() => {
        for (const c of clients) {
          if (c.campaign_manager?.trim())   insert.run(c.workspace_id, c.campaign_manager.trim(),   c.commission_rate || 0);
          if (c.campaign_manager_2?.trim()) insert.run(c.workspace_id, c.campaign_manager_2.trim(), c.commission_rate || 0);
        }
      });
      tx();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/admin/workload', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const rows = db.prepare(`
      SELECT c.id, c.workspace_id, c.workspace_name, c.client_status,
             c.campaign_manager, c.campaign_manager_2, c.commission_rate,
             GROUP_CONCAT(cm.manager_name, ', ') AS managers
      FROM clients c
      LEFT JOIN client_managers cm ON cm.client_workspace_id = c.workspace_id
      GROUP BY c.id
      ORDER BY c.workspace_name
    `).all();
    res.json(rows);
  });

  router.post('/api/admin/workload/assign', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id, manager_name, commission_rate } = req.body || {};
    if (!workspace_id || !manager_name) return res.status(400).json({ error: 'workspace_id and manager_name required' });
    db.prepare(`INSERT OR IGNORE INTO client_managers (client_workspace_id, manager_name, commission_rate) VALUES (?, ?, ?)`)
      .run(workspace_id, manager_name.trim(), parseFloat(commission_rate) || 0);
    res.json({ ok: true });
  });

  router.delete('/api/admin/workload/assign', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id, manager_name } = req.body || {};
    if (!workspace_id || !manager_name) return res.status(400).json({ error: 'workspace_id and manager_name required' });
    db.prepare('DELETE FROM client_managers WHERE client_workspace_id=? AND manager_name=?').run(workspace_id, manager_name);
    res.json({ ok: true });
  });

  router.put('/api/admin/workload/commission', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id, manager_name, commission_rate } = req.body || {};
    if (!workspace_id || !manager_name) return res.status(400).json({ error: 'workspace_id and manager_name required' });
    db.prepare('UPDATE client_managers SET commission_rate=? WHERE client_workspace_id=? AND manager_name=?')
      .run(parseFloat(commission_rate) || 0, workspace_id, manager_name);
    res.json({ ok: true });
  });

  // ── Clients CRUD ──────────────────────────────────────────
  router.get('/api/admin/clients', requireSession, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const rows = db.prepare(`
      SELECT id, username, workspace_id, workspace_name, plan_leads, price_per_lead,
             contact_name, contact_email, contact_phone, website, notes,
             client_status, restart_date, campaign_manager, campaign_manager_2,
             commission_rate, manager_start_date, lead_target_monthly, created_at
      FROM clients ORDER BY workspace_name
    `).all();
    // Attach current managers from client_managers junction
    const cms = db.prepare(`SELECT client_workspace_id, manager_name, commission_rate FROM client_managers`).all();
    const cmsMap = {};
    for (const cm of cms) {
      if (!cmsMap[cm.client_workspace_id]) cmsMap[cm.client_workspace_id] = [];
      cmsMap[cm.client_workspace_id].push(cm);
    }
    res.json(rows.map(r => ({ ...r, managers: cmsMap[r.workspace_id] || [] })));
  });

  router.post('/api/admin/clients', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { username, password, workspace_id, workspace_name, price_per_lead, plan_leads, contact_name, contact_email, contact_phone, website, notes, client_status, campaign_manager, commission_rate, lead_target_monthly } = req.body || {};
    if (!username || !password || !workspace_id || !workspace_name)
      return res.status(400).json({ error: 'username, password, workspace_id and workspace_name required' });
    try {
      db.prepare(`
        INSERT INTO clients (username, password_hash, workspace_id, workspace_name, price_per_lead, plan_leads,
          contact_name, contact_email, contact_phone, website, notes, client_status, campaign_manager, commission_rate, lead_target_monthly)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        username.trim(), bcrypt.hashSync(password, 10), workspace_id.trim(), workspace_name.trim(),
        parseFloat(price_per_lead) || 0, parseInt(plan_leads) || 0,
        contact_name || '', contact_email || '', contact_phone || '', website || '', notes || '',
        client_status || 'active', campaign_manager || '', parseFloat(commission_rate) || 15,
        parseInt(lead_target_monthly) || 0
      );
      res.json({ ok: true });
    } catch (err) {
      if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/admin/clients/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const fields = ['workspace_name','price_per_lead','plan_leads','contact_name','contact_email',
      'contact_phone','website','notes','client_status','restart_date','campaign_manager',
      'campaign_manager_2','commission_rate','manager_start_date','lead_target_monthly'];
    const updates = [];
    const vals    = [];
    for (const f of fields) {
      if (req.body?.[f] !== undefined) {
        updates.push(`${f}=?`);
        vals.push(req.body[f]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE clients SET ${updates.join(',')} WHERE id=?`).run(...vals);
    // Invalidate cached client status/prices
    apiCache.del('client_status');
    apiCache.del('workspace_prices');
    res.json({ ok: true });
  });

  router.put('/api/admin/clients/:id/password', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    db.prepare('UPDATE clients SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
    res.json({ ok: true });
  });

  router.delete('/api/admin/clients/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Client targeting / verticals ─────────────────────────
  router.get('/api/admin/client-verticals', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    res.json(db.prepare('SELECT * FROM client_verticals ORDER BY workspace_name').all());
  });

  router.post('/api/admin/client-verticals', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const {
      workspace_id, workspace_name, vertical, exclude_remote, require_owns_building,
      snooze_months, notes, excluded_industries, excluded_company_sizes,
      excluded_keywords, excluded_counties, excluded_cities, excluded_job_titles,
    } = req.body || {};
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    db.prepare(`
      INSERT INTO client_verticals
        (workspace_id, workspace_name, vertical, exclude_remote, require_owns_building,
         snooze_months, notes, excluded_industries, excluded_company_sizes,
         excluded_keywords, excluded_counties, excluded_cities, excluded_job_titles, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        workspace_name=excluded.workspace_name, vertical=excluded.vertical,
        exclude_remote=excluded.exclude_remote, require_owns_building=excluded.require_owns_building,
        snooze_months=excluded.snooze_months, notes=excluded.notes,
        excluded_industries=excluded.excluded_industries,
        excluded_company_sizes=excluded.excluded_company_sizes,
        excluded_keywords=excluded.excluded_keywords,
        excluded_counties=excluded.excluded_counties,
        excluded_cities=excluded.excluded_cities,
        excluded_job_titles=excluded.excluded_job_titles,
        updated_at=datetime('now')
    `).run(
      workspace_id, workspace_name || '', vertical || '',
      exclude_remote ? 1 : 0, require_owns_building ? 1 : 0,
      parseInt(snooze_months) || 6, notes || '',
      excluded_industries || '', excluded_company_sizes || '',
      excluded_keywords || '', excluded_counties || '',
      excluded_cities || '', excluded_job_titles || ''
    );
    res.json({ ok: true });
  });

  router.get('/api/client-rules/:workspace_id', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const row = db.prepare('SELECT * FROM client_verticals WHERE workspace_id = ?').get(req.params.workspace_id);
    res.json(row || null);
  });

  router.put('/api/clients/:id/notes-exclusions', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { notes, excluded_industries, excluded_company_sizes, excluded_keywords, excluded_counties, excluded_cities, excluded_job_titles } = req.body || {};
    const c = db.prepare('SELECT workspace_id FROM clients WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    db.prepare(`
      INSERT INTO client_verticals (workspace_id, notes, excluded_industries, excluded_company_sizes, excluded_keywords, excluded_counties, excluded_cities, excluded_job_titles, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        notes=excluded.notes,
        excluded_industries=excluded.excluded_industries,
        excluded_company_sizes=excluded.excluded_company_sizes,
        excluded_keywords=excluded.excluded_keywords,
        excluded_counties=excluded.excluded_counties,
        excluded_cities=excluded.excluded_cities,
        excluded_job_titles=excluded.excluded_job_titles,
        updated_at=datetime('now')
    `).run(
      c.workspace_id, notes || '', excluded_industries || '', excluded_company_sizes || '',
      excluded_keywords || '', excluded_counties || '', excluded_cities || '', excluded_job_titles || ''
    );
    res.json({ ok: true });
  });

  // ── Cache management ──────────────────────────────────────
  router.post('/api/admin/cache/clear', requireAdmin, (req, res) => {
    apiCache.flushAll();
    res.json({ ok: true });
  });

  router.get('/api/admin/cache/stats', requireAdmin, (req, res) => {
    res.json(apiCache.getStats());
  });

  // ── Non-lead requests (admin approval/rejection) ──────────
  router.get('/api/admin/nonlead-requests', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const rows = db.prepare(`
      SELECT nr.*, c.workspace_name
      FROM nonlead_requests nr
      JOIN clients c ON c.id = nr.client_id
      WHERE nr.status = 'pending'
      ORDER BY nr.created_at DESC
    `).all();
    res.json(rows);
  });

  router.post('/api/admin/nonlead-requests/:id/approve', requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const nr = db.prepare('SELECT * FROM nonlead_requests WHERE id=?').get(req.params.id);
    if (!nr) return res.status(404).json({ error: 'Request not found' });
    db.prepare(`UPDATE leads SET status='nonlead' WHERE id=?`).run(nr.lead_id);
    db.prepare(`UPDATE nonlead_requests SET status='approved' WHERE id=?`).run(req.params.id);
    // Fire webhook to N8n
    try {
      await fetch(process.env.NONLEAD_WEBHOOK_URL || 'https://n8n1-n8n.xuobbb.easypanel.host/webhook/ottaly-nonlead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: nr.lead_id, workspace_id: nr.workspace_id, reason: nr.reason }),
      });
    } catch (err) { console.warn('[nonlead-approve] webhook failed:', err.message); }
    res.json({ ok: true });
  });

  router.post('/api/admin/nonlead-requests/:id/reject', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    db.prepare(`UPDATE nonlead_requests SET status='rejected' WHERE id=?`).run(req.params.id);
    db.prepare(`UPDATE leads SET status='active' WHERE id=(SELECT lead_id FROM nonlead_requests WHERE id=?)`).run(req.params.id);
    res.json({ ok: true });
  });

  // ── Webhook events viewer ─────────────────────────────────
  router.get('/api/admin/webhook-events', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const rows = db.prepare(`
      SELECT id, source, event_type, email, processed, processed_at, error, received_at,
             SUBSTR(payload, 1, 500) AS payload_preview
      FROM webhook_events
      ORDER BY received_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n;
    res.json({ rows, total, limit, offset });
  });

  // ── Admin workspaces list ─────────────────────────────────
  router.get('/api/admin/workspaces', requireAdmin, async (req, res) => {
    try {
      const pvData = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
        headers: { 'x-api-key': ctx.PLUSVIBE_KEY },
      });
      if (!pvData.ok) throw new Error(`PlusVibe ${pvData.status}`);
      const json = await pvData.json();
      res.json(json);
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Client status (admin can update) ─────────────────────
  router.post('/api/client-status/:id', requireAdmin, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { client_status, restart_date } = req.body || {};
    if (!['active','inactive'].includes(client_status))
      return res.status(400).json({ error: 'Invalid status' });
    db.prepare(`UPDATE clients SET client_status=?, restart_date=? WHERE id=?`)
      .run(client_status, restart_date || null, req.params.id);
    res.json({ ok: true });
    // Trigger immediate cache refreshes
    if (typeof refreshRevenueCache === 'function') refreshRevenueCache().catch(() => {});
    if (typeof refreshCampaignCache === 'function') refreshCampaignCache().catch(() => {});
  });

  return router;
}

module.exports = makeRouter;
