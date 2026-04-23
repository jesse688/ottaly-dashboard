const express   = require('express');
const Database  = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const Stripe    = require('stripe');

const app  = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET             = process.env.JWT_SECRET             || 'ottaly-dev-secret-change-in-prod';
const ADMIN_KEY              = process.env.ADMIN_KEY              || 'ottaly-admin';
const PLUSVIBE_KEY           = process.env.PLUSVIBE_KEY           || '6425e882-f33fb46a-2837ff5a-eb535a60';
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  || '';
const APP_URL                = process.env.APP_URL                || 'http://localhost:3000';
const NONLEAD_WEBHOOK_URL    = 'https://n8n1-n8n.xuobbb.easypanel.host/webhook/ottaly-nonlead';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ── Database ──────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'ottaly.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT    UNIQUE NOT NULL,
    password_hash      TEXT    NOT NULL,
    workspace_id       TEXT    NOT NULL,
    workspace_name     TEXT    NOT NULL,
    plan_leads         INTEGER DEFAULT 0,
    price_per_lead     REAL    DEFAULT 0,
    stripe_customer_id TEXT,
    created_at         TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id           TEXT    PRIMARY KEY,
    workspace_id TEXT    NOT NULL,
    data         TEXT    NOT NULL,
    closed_value REAL,
    status       TEXT    DEFAULT 'active',
    received_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leads_ws ON leads(workspace_id);
  CREATE TABLE IF NOT EXISTS nonlead_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      TEXT    NOT NULL,
    client_id    INTEGER NOT NULL,
    workspace_id TEXT    NOT NULL,
    reason       TEXT    NOT NULL,
    status       TEXT    DEFAULT 'pending',
    created_at   TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id         INTEGER NOT NULL,
    leads_purchased   INTEGER NOT NULL,
    amount_paid       INTEGER NOT NULL,
    stripe_session_id TEXT,
    created_at        TEXT    DEFAULT (datetime('now'))
  );
`);

// Migrations for existing deployments
for (const sql of [
  `ALTER TABLE clients ADD COLUMN plan_leads INTEGER DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN price_per_lead REAL DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT`,
  `ALTER TABLE leads ADD COLUMN closed_value REAL`,
  `ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'active'`,
  `ALTER TABLE leads ADD COLUMN received_at TEXT`,
]) { try { db.exec(sql); } catch {} }

// Backfill any leads that arrived before received_at column existed
db.exec(`UPDATE leads SET received_at = datetime('now') WHERE received_at IS NULL`);

// ── Stripe webhook — MUST be before express.json() ────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET)
    return res.status(503).json({ error: 'Stripe webhook not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const s          = event.data.object;
    const clientId   = parseInt(s.metadata?.client_id);
    const leadsCount = parseInt(s.metadata?.leads_count);
    if (clientId && leadsCount) {
      db.prepare('UPDATE clients SET plan_leads = plan_leads + ? WHERE id = ?').run(leadsCount, clientId);
      db.prepare('INSERT INTO transactions (client_id, leads_purchased, amount_paid, stripe_session_id) VALUES (?,?,?,?)')
        .run(clientId, leadsCount, s.amount_total || 0, s.id);
    }
  }
  res.json({ received: true });
});

// ── Middleware ─────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname)));

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.client = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session' }); }
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Auth ───────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
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

// ── Webhook — receives leads from N8n ──────────────────────
app.post('/webhook/lead', (req, res) => {
  const payload = Array.isArray(req.body) ? req.body[0]?.body : req.body;
  if (!payload?.workspace_id || !payload?._id)
    return res.status(400).json({ error: 'Missing workspace_id or _id' });

  const existing = db.prepare('SELECT status, closed_value FROM leads WHERE id = ?').get(payload._id);
  if (existing) {
    db.prepare('UPDATE leads SET workspace_id = ?, data = ? WHERE id = ?')
      .run(payload.workspace_id, JSON.stringify(payload), payload._id);
  } else {
    db.prepare('INSERT INTO leads (id, workspace_id, data, received_at) VALUES (?, ?, ?, datetime(\'now\'))')
      .run(payload._id, payload.workspace_id, JSON.stringify(payload));
  }
  console.log(`Lead received: ${payload.first_name} ${payload.last_name} → ${payload.workspace_name}`);
  res.json({ ok: true });
});

// ── Client stats ───────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  const delivered = db.prepare(
    `SELECT COUNT(*) as n FROM leads WHERE workspace_id = ? AND (status = 'active' OR status IS NULL)`
  ).get(c.workspace_id).n;
  const closed = db.prepare(
    `SELECT COALESCE(SUM(closed_value),0) as t FROM leads WHERE workspace_id = ? AND (status = 'active' OR status IS NULL)`
  ).get(c.workspace_id).t;
  const spent     = delivered * (c.price_per_lead || 0);
  const remaining = Math.max(0, (c.plan_leads || 0) - delivered);
  const roi       = spent > 0 ? Math.round(closed / spent * 100) : null;
  res.json({
    delivered,
    remaining,
    plan_leads:     c.plan_leads     || 0,
    spent,
    price_per_lead: c.price_per_lead || 0,
    closed_value:   closed,
    roi,
  });
});

// ── Client leads list ──────────────────────────────────────
app.get('/api/leads', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, workspace_id, data, closed_value, status, received_at
    FROM leads WHERE workspace_id = ?
    ORDER BY received_at DESC
  `).all(req.client.workspace_id);

  res.json(rows.map(r => {
    const d = JSON.parse(r.data);
    return {
      id:              r.id,
      received_at:     r.received_at,
      status:          r.status || 'active',
      closed_value:    r.closed_value,
      first_name:      d.first_name,
      last_name:       d.last_name,
      company_name:    d.company_name,
      email:           d.email,
      job_title:       d.job_title,
      city:            d.city,
      country:         d.country,
      phone:           d.phone_number || d.phone || '',
      website:         d.website      || '',
      linkedin:        d.linkedin_url || d.linkedin || '',
      sentiment:       d.sentiment,
      subject:         d.last_lead_reply_subject || d.latest_subject || '',
      snippet:         (d.text_body || '').substring(0, 120),
      last_reply_html: d.last_lead_reply || d.latest_message || '',
      campaign_name:   d.campaign_name || '',
      email_account:   d.email_account_name || '',
      last_email_id:   d.last_email_id,
      last_thread_id:  d.last_thread_id,
      workspace_id:    d.workspace_id,
    };
  }));
});

// ── Set closed deal value ──────────────────────────────────
app.post('/api/leads/:id/value', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  const value = parseFloat(req.body?.value);
  if (isNaN(value) || value < 0) return res.status(400).json({ error: 'Invalid value' });
  db.prepare('UPDATE leads SET closed_value = ? WHERE id = ?').run(value, req.params.id);
  res.json({ ok: true });
});

// ── Submit non-lead request ────────────────────────────────
app.post('/api/leads/:id/nonlead', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  if (row.status === 'nonlead_pending')
    return res.status(400).json({ error: 'Request already pending' });
  if (row.status === 'nonlead')
    return res.status(400).json({ error: 'Already marked as not a lead' });
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: 'Reason required' });
  db.prepare(`UPDATE leads SET status = 'nonlead_pending' WHERE id = ?`).run(req.params.id);
  db.prepare(`INSERT INTO nonlead_requests (lead_id, client_id, workspace_id, reason) VALUES (?,?,?,?)`)
    .run(req.params.id, req.client.id, req.client.workspace_id, reason.trim());
  res.json({ ok: true });
});

// ── Full thread from PlusVibe ──────────────────────────────
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
    res.json({ source: 'plusvibe', data: await r.json() });
  } catch {
    res.json({
      source: 'webhook',
      data: { messages: [{
        from:    lead.email,
        to:      lead.email_account_name,
        subject: lead.last_lead_reply_subject || '',
        body:    lead.last_lead_reply || lead.latest_message || '',
        date:    lead.modified_at,
      }] }
    });
  }
});

// ── Reply ──────────────────────────────────────────────────
app.post('/api/leads/:id/reply', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT data FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  const lead   = JSON.parse(row.data);
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body required' });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe checkout session ────────────────────────────────
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const qty = parseInt(req.body?.leads_count);
  if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  if (!c.price_per_lead) return res.status(400).json({ error: 'No price configured for this account. Contact support.' });

  let customerId = c.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { client_id: String(c.id), username: c.username }
    });
    customerId = customer.id;
    db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run(customerId, c.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency:     'gbp',
        unit_amount:  Math.round(c.price_per_lead * 100),
        product_data: { name: `Ottaly Leads — ${qty} lead${qty > 1 ? 's' : ''}` },
      },
      quantity: qty,
    }],
    mode:        'payment',
    success_url: `${APP_URL}/client.html?payment=success`,
    cancel_url:  `${APP_URL}/client.html`,
    metadata:    { client_id: String(c.id), leads_count: String(qty) },
  });
  res.json({ url: session.url });
});

// ── Stripe customer portal ─────────────────────────────────
app.post('/api/stripe/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const c = db.prepare('SELECT stripe_customer_id FROM clients WHERE id = ?').get(req.client.id);
  if (!c?.stripe_customer_id)
    return res.status(400).json({ error: 'No billing account yet. Make a purchase first.' });
  const session = await stripe.billingPortal.sessions.create({
    customer:   c.stripe_customer_id,
    return_url: `${APP_URL}/client.html`,
  });
  res.json({ url: session.url });
});

// ── Agency lead counts (uses SQLite received_at) ──────────
app.get('/api/agency/leads', (req, res) => {
  const { workspace_id, start_date, end_date } = req.query;
  if (!workspace_id || !start_date || !end_date)
    return res.status(400).json({ error: 'Missing params' });
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE workspace_id = ?
    AND (status IS NULL OR status NOT IN ('nonlead','nonlead_pending'))
    AND received_at IS NOT NULL
    AND date(received_at) >= date(?)
    AND date(received_at) <= date(?)
  `).get(workspace_id, start_date, end_date);
  res.json({ count: row.count });
});

// ── Workspace prices (public — used by Revenue page) ──────
app.get('/api/workspace-prices', (req, res) => {
  const rows = db.prepare(`SELECT workspace_id, workspace_name, price_per_lead FROM clients`).all();
  res.json(rows);
});

// ── PlusVibe proxy (public — avoids CORS from browser) ────
app.get('/api/pv/workspaces', async (req, res) => {
  try {
    const r = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
      headers: { 'x-api-key': PLUSVIBE_KEY }
    });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pv/workspace-leads', async (req, res) => {
  const { workspace_id, page, limit } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });
  try {
    // No label filter — fetch all leads and let client filter negatives
    const qs = new URLSearchParams({ workspace_id, page: page || 1, limit: limit || 100 });
    const r = await fetch(`https://api.plusvibe.ai/api/v1/lead/workspace-leads?${qs}`, {
      headers: { 'x-api-key': PLUSVIBE_KEY }
    });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin — workspaces ─────────────────────────────────────
app.get('/api/admin/workspaces', requireAdmin, async (req, res) => {
  try {
    const r = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
      headers: { 'x-api-key': PLUSVIBE_KEY }
    });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin — clients ────────────────────────────────────────
app.get('/api/admin/clients', requireAdmin, (req, res) => {
  res.json(db.prepare(
    'SELECT id, username, workspace_id, workspace_name, plan_leads, price_per_lead, stripe_customer_id, created_at FROM clients ORDER BY created_at DESC'
  ).all());
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { username, password, workspace_id, workspace_name, plan_leads, price_per_lead } = req.body || {};
  if (!username || !password || !workspace_id || !workspace_name)
    return res.status(400).json({ error: 'All fields required' });
  try {
    db.prepare(
      'INSERT INTO clients (username, password_hash, workspace_id, workspace_name, plan_leads, price_per_lead) VALUES (?,?,?,?,?,?)'
    ).run(username, bcrypt.hashSync(password, 10), workspace_id, workspace_name,
         parseInt(plan_leads) || 0, parseFloat(price_per_lead) || 0);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Username already exists' }); }
});

app.put('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const { plan_leads, price_per_lead } = req.body || {};
  if (plan_leads !== undefined)
    db.prepare('UPDATE clients SET plan_leads = ? WHERE id = ?')
      .run(parseInt(plan_leads) || 0, req.params.id);
  if (price_per_lead !== undefined)
    db.prepare('UPDATE clients SET price_per_lead = ? WHERE id = ?')
      .run(parseFloat(price_per_lead) || 0, req.params.id);
  res.json({ ok: true });
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

// ── Admin — non-lead requests ──────────────────────────────
app.get('/api/admin/nonlead-requests', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT nlr.id, nlr.lead_id, nlr.client_id, nlr.reason, nlr.created_at,
           c.username, c.workspace_name, l.data as lead_data
    FROM nonlead_requests nlr
    JOIN clients c ON c.id = nlr.client_id
    LEFT JOIN leads l ON l.id = nlr.lead_id
    WHERE nlr.status = 'pending'
    ORDER BY nlr.created_at DESC
  `).all();
  res.json(rows.map(r => {
    const lead = r.lead_data ? JSON.parse(r.lead_data) : {};
    return {
      id:             r.id,
      lead_id:        r.lead_id,
      client_id:      r.client_id,
      username:       r.username,
      workspace_name: r.workspace_name,
      reason:         r.reason,
      created_at:     r.created_at,
      lead_name:      `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lead_email:     lead.email || '',
    };
  }));
});

app.post('/api/admin/nonlead-requests/:id/approve', requireAdmin, async (req, res) => {
  const nlr = db.prepare('SELECT * FROM nonlead_requests WHERE id = ?').get(req.params.id);
  if (!nlr) return res.status(404).json({ error: 'Request not found' });
  const leadRow  = db.prepare('SELECT data FROM leads WHERE id = ?').get(nlr.lead_id);
  const leadData = leadRow ? JSON.parse(leadRow.data) : {};
  db.prepare(`UPDATE leads SET status = 'nonlead' WHERE id = ?`).run(nlr.lead_id);
  db.prepare(`UPDATE nonlead_requests SET status = 'approved' WHERE id = ?`).run(nlr.id);
  try {
    await fetch(NONLEAD_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:        leadData.email || '',
        reason:       nlr.reason,
        timestamp:    new Date().toISOString(),
        lead_id:      nlr.lead_id,
        workspace_id: nlr.workspace_id,
      })
    });
  } catch {}
  res.json({ ok: true });
});

app.post('/api/admin/nonlead-requests/:id/reject', requireAdmin, (req, res) => {
  const nlr = db.prepare('SELECT * FROM nonlead_requests WHERE id = ?').get(req.params.id);
  if (!nlr) return res.status(404).json({ error: 'Request not found' });
  db.prepare(`UPDATE leads SET status = 'active' WHERE id = ?`).run(nlr.lead_id);
  db.prepare(`UPDATE nonlead_requests SET status = 'rejected' WHERE id = ?`).run(nlr.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Ottaly running on http://localhost:${PORT}`));
