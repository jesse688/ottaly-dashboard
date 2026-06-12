'use strict';
/**
 * routes/auth.js
 * JWT client login, cookie-based admin/manager session, logout helpers,
 * session info endpoint, and the /api/login client auth route.
 *
 * Extracted from server.js lines ~650–1922.
 * Mounted with: app.use('/', authRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db              - better-sqlite3 instance
 * @param {object}   ctx.bcrypt          - bcryptjs
 * @param {object}   ctx.jwt             - jsonwebtoken
 * @param {string}   ctx.JWT_SECRET
 * @param {string}   ctx.ADMIN_KEY
 * @param {string}   ctx.SESSION_SECRET
 * @param {Function} ctx.setSessionCookie
 * @param {Function} ctx.clearSessionCookie
 * @param {Function} ctx.decodeSession
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 */
function makeRouter(ctx) {
  const {
    db, bcrypt, jwt,
    JWT_SECRET, ADMIN_KEY, SESSION_SECRET,
    setSessionCookie, clearSessionCookie, decodeSession,
    requireSession, requireAdmin,
  } = ctx;

  const router = express.Router();

  // ── Session info ──────────────────────────────────────────
  router.get('/api/session', (req, res) => {
    const s = decodeSession(req);
    if (!s) {
      const raw = req.headers.cookie || '';
      const m   = raw.match(/(?:^|;\s*)ottaly_admin=([^;]+)/);
      if (m) { try { jwt.verify(m[1], JWT_SECRET + ADMIN_KEY); return res.json({ ok: true, role: 'admin', name: 'Admin' }); } catch {} }
      return res.status(401).json({ ok: false });
    }
    if (s.role === 'manager' && db) {
      const mgr = db.prepare('SELECT commission_rate FROM managers WHERE LOWER(name)=LOWER(?)').get(s.name || '');
      return res.json({ ok: true, role: s.role, name: s.name || '', commission_rate: mgr?.commission_rate ?? 15 });
    }
    res.json({ ok: true, role: s.role, name: s.name || 'Admin' });
  });

  router.get('/api/manager/rate', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const s = decodeSession(req);
    const name = s?.role === 'admin' ? (req.query.name || s?.name || '') : (s?.name || '');
    const mgr = db.prepare('SELECT commission_rate, base_salary FROM managers WHERE LOWER(name)=LOWER(?)').get(name.trim());
    res.json({ name, commission_rate: mgr?.commission_rate ?? 15, base_salary: mgr?.base_salary ?? 0 });
  });

  // ── Admin + manager login (inside if(db) in original) ────
  router.post('/api/admin/login', (req, res) => {
    const { key } = req.body || {};
    if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Wrong key' });
    setSessionCookie(res, { role: 'admin', name: 'Admin' });
    res.json({ ok: true, role: 'admin' });
  });

  router.post('/api/manager/login', (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name, password } = req.body || {};
    if (!name || !password) return res.status(400).json({ error: 'Missing fields' });
    const mgr = db.prepare('SELECT * FROM managers WHERE LOWER(name)=LOWER(?)').get(name.trim());
    if (!mgr || !bcrypt.compareSync(password, mgr.password_hash))
      return res.status(401).json({ error: 'Incorrect name or password' });
    setSessionCookie(res, { role: 'manager', name: mgr.name });
    res.json({ ok: true, role: 'manager', name: mgr.name });
  });

  router.post('/api/logout', (req, res) => {
    clearSessionCookie(res);
    res.setHeader('Set-Cookie', [
      'ottaly_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
      'ottaly_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict'
    ]);
    res.json({ ok: true });
  });

  // Legacy compat
  router.post('/api/admin/logout', (req, res) => {
    clearSessionCookie(res);
    res.setHeader('Set-Cookie', 'ottaly_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    res.json({ ok: true });
  });

  router.get('/api/admin/verify', (req, res) => {
    const s = decodeSession(req);
    if (s?.role === 'admin') return res.json({ ok: true });
    const raw = req.headers.cookie || '';
    const m   = raw.match(/(?:^|;\s*)ottaly_admin=([^;]+)/);
    if (m) { try { jwt.verify(m[1], JWT_SECRET + ADMIN_KEY); return res.json({ ok: true }); } catch {} }
    res.status(401).json({ ok: false });
  });

  // ── Client (JWT) login ────────────────────────────────────
  router.post('/api/login', (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const c = db.prepare('SELECT * FROM clients WHERE username = ?').get(username);
    if (!c || !bcrypt.compareSync(password, c.password_hash))
      return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign(
      { id: c.id, workspace_id: c.workspace_id, workspace_name: c.workspace_name, username: c.username },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, workspace_name: c.workspace_name, username: c.username });
  });

  return router;
}

module.exports = makeRouter;
