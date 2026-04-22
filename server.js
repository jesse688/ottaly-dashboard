const express   = require('express');
const Database  = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET   = process.env.JWT_SECRET   || 'ottaly-dev-secret-change-in-prod';
const ADMIN_KEY    = process.env.ADMIN_KEY     || 'ottaly-admin';
const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY  || '6425e882-f33fb46a-2837ff5a-eb535a60';

// ── Database ─────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'ottaly.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    UNIQUE NOT NULL,
    password_hash  TEXT    NOT NULL,
    workspace_id   TEXT    NOT NULL,
    workspace_name TEXT    NOT NULL,
    created_at     TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    data         TEXT NOT NULL,
    received_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leads_ws ON leads(workspace_id);
`);

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname)));

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.client = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Auth ──────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const c = db.prepare('SELECT * FROM clients WHERE username = ?').get(username);
  if (!c || !bcrypt.compareSync(password, c.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign(
    { id: c.id, workspace_id: c.workspace_id, workspace_name: c.workspace_name, username: c.username },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, workspace_name: c.workspace_name, username: c.username });
});

// ── Webhook — receives leads from N8n ─────────────────────
app.post('/webhook/lead', (req, res) => {
  // N8n sends an array; the lead data is in body[0].body
  const payload = Array.isArray(req.body) ? req.body[0]?.body : req.body;
  if (!payload?.workspace_id || !payload?._id)
    return res.status(400).json({ error: 'Missing workspace_id or _id' });

  db.prepare(`
    INSERT OR REPLACE INTO leads (id, workspace_id, data)
    VALUES (?, ?, ?)
  `).run(payload._id, payload.workspace_id, JSON.stringify(payload));

  console.log(`Lead received: ${payload.first_name} ${payload.last_name} → workspace ${payload.workspace_name}`);
  res.json({ ok: true });
});

// ── Client — leads list ───────────────────────────────────
app.get('/api/leads', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, workspace_id, data, received_at
    FROM leads WHERE workspace_id = ?
    ORDER BY received_at DESC
  `).all(req.client.workspace_id);

  res.json(rows.map(r => {
    const d = JSON.parse(r.data);
    return {
      id:            r.id,
      received_at:   r.received_at,
      first_name:    d.first_name,
      last_name:     d.last_name,
      company_name:  d.company_name,
      email:         d.email,
      job_title:     d.job_title,
      city:          d.city,
      country:       d.country,
      sentiment:     d.sentiment,
      subject:       d.last_lead_reply_subject || d.latest_subject || '',
      snippet:       (d.text_body || '').substring(0, 120),
      last_reply_html: d.last_lead_reply || d.latest_message || '',
      campaign_name: d.campaign_name || '',
      email_account: d.email_account_name || '',
      last_email_id: d.last_email_id,
      last_thread_id: d.last_thread_id,
      workspace_id:  d.workspace_id,
    };
  }));
});

// ── Client — full thread from PlusVibe ────────────────────
app.get('/api/leads/:id/thread', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT data FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });

  const lead = JSON.parse(row.data);

  try {
    const r = await fetch(
      `https://api.plusvibe.ai/api/v1/unibox/emails?workspace_id=${lead.workspace_id}&thread_id=${lead.last_thread_id}`,
      { headers: { 'x-api-key': PLUSVIBE_KEY } }
    );
    if (!r.ok) throw new Error(`PlusVibe ${r.status}`);
    const data = await r.json();
    res.json({ source: 'plusvibe', data });
  } catch {
    // Fallback: return what we have from the webhook
    res.json({
      source: 'webhook',
      data: {
        messages: [{
          from:    lead.email,
          to:      lead.email_account_name,
          subject: lead.last_lead_reply_subject || '',
          body:    lead.last_lead_reply || lead.latest_message || '',
          date:    lead.modified_at,
        }]
      }
    });
  }
});

// ── Client — reply ────────────────────────────────────────
app.post('/api/leads/:id/reply', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT data FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });

  const lead    = JSON.parse(row.data);
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body required' });

  // Wrap plain text in paragraph tags if not already HTML
  const htmlBody = body.includes('<') ? body : `<p>${body.replace(/\n/g, '</p><p>')}</p>`;

  try {
    const r = await fetch(
      `https://api.plusvibe.ai/api/v1/unibox/emails/reply?workspace_id=${lead.workspace_id}`,
      {
        method:  'POST',
        headers: { 'x-api-key': PLUSVIBE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply_to_id: lead.last_email_id,
          subject:     `Re: ${lead.last_lead_reply_subject || lead.latest_subject || ''}`,
          from:        lead.email_account_name,
          to:          lead.email,
          body:        htmlBody,
        })
      }
    );
    const result = await r.json();
    if (!r.ok) return res.status(r.status).json(result);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin — list workspaces from PlusVibe ─────────────────
app.get('/api/admin/workspaces', requireAdmin, async (req, res) => {
  try {
    const r = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
      headers: { 'x-api-key': PLUSVIBE_KEY }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin — manage clients ────────────────────────────────
app.get('/api/admin/clients', requireAdmin, (req, res) => {
  res.json(db.prepare(
    'SELECT id, username, workspace_id, workspace_name, created_at FROM clients ORDER BY created_at DESC'
  ).all());
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { username, password, workspace_id, workspace_name } = req.body || {};
  if (!username || !password || !workspace_id || !workspace_name)
    return res.status(400).json({ error: 'All fields required' });
  try {
    db.prepare(
      'INSERT INTO clients (username, password_hash, workspace_id, workspace_name) VALUES (?, ?, ?, ?)'
    ).run(username, bcrypt.hashSync(password, 10), workspace_id, workspace_name);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.put('/api/admin/clients/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Ottaly running on http://localhost:${PORT}`));
