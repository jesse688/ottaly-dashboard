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

// Non-lead overrides (keyed by email — persists across restarts, survives cache rebuilds)
db.exec(`CREATE TABLE IF NOT EXISTS nonlead_overrides (
  email      TEXT PRIMARY KEY,
  reason     TEXT DEFAULT '',
  marked_at  TEXT DEFAULT (datetime('now')),
  active     INTEGER DEFAULT 1
)`);

// Migrations for existing deployments
for (const sql of [
  `ALTER TABLE clients ADD COLUMN plan_leads INTEGER DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN price_per_lead REAL DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT`,
  `ALTER TABLE clients ADD COLUMN contact_name TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN contact_email TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN contact_phone TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN website TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN notes TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN client_status TEXT DEFAULT 'active'`,
  `ALTER TABLE clients ADD COLUMN restart_date TEXT DEFAULT NULL`,
  `ALTER TABLE leads ADD COLUMN closed_value REAL`,
  `ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'active'`,
  `ALTER TABLE leads ADD COLUMN received_at TEXT`,
]) { try { db.exec(sql); } catch {} }

// Backfill any leads that arrived before received_at column existed
db.exec(`UPDATE leads SET received_at = datetime('now') WHERE received_at IS NULL`);

// Auto-reactivate clients whose restart_date has passed
function checkClientReactivations() {
  const today = new Date().toISOString().split('T')[0];
  const changed = db.prepare(`
    UPDATE clients SET client_status='active', restart_date=NULL
    WHERE client_status='inactive' AND restart_date IS NOT NULL AND restart_date <= ?
  `).run(today);
  if (changed.changes > 0) console.log(`[clients] Auto-reactivated ${changed.changes} client(s)`);
}
checkClientReactivations();
setInterval(checkClientReactivations, 60 * 60 * 1000); // check hourly

// ── Client seed — prices & commission earners ─────────────
const CLIENT_SEED = [
  { workspace_id: '690ee665bcb253de4fb44538', workspace_name: 'Ottaly',                     price_per_lead: 1,      contact_name: ''     },
  { workspace_id: '6912ddfef9582848982b9a62', workspace_name: 'AccrueAccounting',            price_per_lead: 72.99,  contact_name: 'Joey' },
  { workspace_id: '691ed9eaa1b5035dd42b4d86', workspace_name: 'Volancy',                    price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '6932e1e2d3beeb70040857e7', workspace_name: 'AIVI',                       price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '693fc9d9fd3453ffb933c88c', workspace_name: 'FleetSauce',                 price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '695259b0d1677bc04d5a3aa8', workspace_name: 'Stribe',                     price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '695259c3d6154e27d164bcf7', workspace_name: 'Indigo',                     price_per_lead: 79.99,  contact_name: ''     },
  { workspace_id: '695259dc8de377db7577dc45', workspace_name: 'PPC',                        price_per_lead: 99.99,  contact_name: 'Joey' },
  { workspace_id: '695259ea8de377db7577dc46', workspace_name: 'JMC Accountants',            price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '69525a0eceae00718efdaeaa', workspace_name: 'HydrationCompany',           price_per_lead: 72.99,  contact_name: ''     },
  { workspace_id: '6964c76a36e2bd2af31c7adf', workspace_name: 'V4One',                      price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '6964ec1b2364418165378b13', workspace_name: 'Rural & Country',            price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '6964ec4f693ae16dcb15b9f7', workspace_name: 'TangerineTax',               price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '6967e4b912a9eb99bbafe356', workspace_name: "Tristan's Workspace",        price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '696e3c1682c0ae8e5357c552', workspace_name: 'FAIT',                       price_per_lead: 0,      contact_name: ''     },
  { workspace_id: '697e20f02db8460f8ba68792', workspace_name: 'Jumping Spider',             price_per_lead: 100,    contact_name: ''     },
  { workspace_id: '6989ac90bb085fcd05167fc9', workspace_name: 'Josh - Commercial Flooring', price_per_lead: 189.99, contact_name: ''     },
  { workspace_id: '699714b02f0830a7148fcf3e', workspace_name: 'Enviro',                     price_per_lead: 89,     contact_name: 'Joey' },
  { workspace_id: '69a686632f5aaca7d9602c1f', workspace_name: 'Animo',                      price_per_lead: 195,    contact_name: ''     },
  { workspace_id: '69a9db287af7ef2854f57636', workspace_name: 'GGRS',                       price_per_lead: 178,    contact_name: 'Joey' },
  { workspace_id: '69a9db307af7ef2854f57637', workspace_name: 'ButterflyEco',               price_per_lead: 205,    contact_name: ''     },
  { workspace_id: '69c43d1407bf312ff0026642', workspace_name: 'GXI',                        price_per_lead: 169,    contact_name: 'Joey' },
  { workspace_id: '69c43d1e07bf312ff0026643', workspace_name: 'AuraaDesign',                price_per_lead: 100,    contact_name: ''     },
  { workspace_id: '69ce40f616a9cc965746b1a6', workspace_name: 'Ottaly Test Account',        price_per_lead: 0,      contact_name: ''     },
];

const upsertClient = db.prepare(`
  INSERT INTO clients (username, password_hash, workspace_id, workspace_name, price_per_lead, contact_name)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET
    price_per_lead = excluded.price_per_lead,
    contact_name   = excluded.contact_name,
    workspace_id   = excluded.workspace_id,
    workspace_name = excluded.workspace_name
`);
for (const s of CLIENT_SEED) {
  const existing = db.prepare('SELECT id, price_per_lead FROM clients WHERE workspace_id = ?').get(s.workspace_id);
  if (existing) {
    // Never overwrite a manually-set price — only update if seed has a real price AND current is 0
    const newPrice = (s.price_per_lead > 0 && (existing.price_per_lead || 0) === 0)
      ? s.price_per_lead : existing.price_per_lead;
    db.prepare(`UPDATE clients SET workspace_name=?, contact_name=?, price_per_lead=? WHERE workspace_id=?`)
      .run(s.workspace_name, s.contact_name, newPrice, s.workspace_id);
  } else {
    const tempHash = bcrypt.hashSync('Ottaly2025!', 10);
    upsertClient.run(
      s.workspace_name.toLowerCase().replace(/\s+/g, '_'),
      tempHash, s.workspace_id, s.workspace_name, s.price_per_lead, s.contact_name
    );
  }
}

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

// ── Client status (public — single source of truth for all pages) ──
app.get('/api/client-status', (req, res) => {
  const rows = db.prepare(`SELECT workspace_id, workspace_name, client_status, restart_date FROM clients`).all();
  res.json(rows);
});

app.post('/api/client-status/:id', requireAdmin, (req, res) => {
  const { client_status, restart_date } = req.body || {};
  if (!['active','inactive'].includes(client_status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE clients SET client_status=?, restart_date=? WHERE id=?`)
    .run(client_status, restart_date || null, req.params.id);
  res.json({ ok: true });
  // Trigger immediate cache refreshes so change takes effect right away
  refreshRevenueCache().catch(() => {});
  refreshCampaignCache().catch(() => {});
});

// ── Workspace prices (public — used by Revenue page) ──────
app.get('/api/workspace-prices', (req, res) => {
  const rows = db.prepare(`SELECT workspace_id, workspace_name, price_per_lead, client_status FROM clients`).all();
  res.json(rows);
});

// ── Revenue leads cache (refreshed every 3 min server-side) ──
const LEAD_LABELS = ['LEAD', 'MEETING_BOOKED', 'MEETING_COMPLETED', 'CLOSED', 'ADDED_TO_ZOHO', 'AWAITING_REPLY', 'NON_LEAD', 'WEAK_LEAD'];
let revenueCache = { leads: [], updatedAt: null };

async function pvFetch(path) {
  const r = await fetch(`https://api.plusvibe.ai/api/v1${path}`, {
    headers: { 'x-api-key': PLUSVIBE_KEY }
  });
  if (!r.ok) throw new Error(`PlusVibe ${r.status}: ${path}`);
  return r.json();
}

async function refreshRevenueCache() {
  try {
    const [wsRaw, prices] = await Promise.all([
      pvFetch('/workspaces'),
      Promise.resolve(db.prepare('SELECT workspace_id, price_per_lead FROM clients').all())
    ]);
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || wsRaw?.data || []);
    const priceMap = {};
    const statusMap = {};
    prices.forEach(p => {
      priceMap[p.workspace_id]  = p.price_per_lead || 0;
      statusMap[p.workspace_id] = p.client_status || 'active';
    });

    const leads = [];
    for (const ws of workspaces) {
      const wsPrice    = priceMap[ws.id]  || 0;
      const wsInactive = statusMap[ws.id] === 'inactive';
      const seenIds = new Set();
      for (const label of LEAD_LABELS) {
        for (let page = 1; page <= 20; page++) {
          let batch;
          try {
            const raw = await pvFetch(`/lead/workspace-leads?workspace_id=${ws.id}&label=${label}&page=${page}&limit=100`);
            batch = Array.isArray(raw) ? raw : (raw?.leads || raw?.data || []);
          } catch(e) { break; }
          if (!batch.length) break;
          batch.forEach(l => {
            if (seenIds.has(l._id)) return;
            seenIds.add(l._id);
            leads.push({
              client_name:    ws.name || ws.workspace_name || 'Unknown',
              workspace_id:   ws.id,
              campaign:       l.camp_name || '',
              first_name:     l.first_name  || l.firstName  || '',
              last_name:      l.last_name   || l.lastName   || '',
              lead_email:     l.email || '',
              lead_price:     wsPrice,
              label:          l.label || '',
              date:           l.modified_at || l.created_at || null,
              client_inactive: wsInactive,
            });
          });
          if (batch.length < 100) break;
        }
      }
    }
    revenueCache = { leads, updatedAt: new Date().toISOString() };
    console.log(`[revenue cache] refreshed — ${leads.length} total leads`);
  } catch (err) {
    console.error('[revenue cache] refresh failed:', err.message);
  }
}

// Refresh on startup then every 3 minutes
refreshRevenueCache();
setInterval(refreshRevenueCache, 3 * 60 * 1000);

app.get('/api/revenue/leads', (req, res) => {
  // Apply non-lead overrides from SQLite
  const overrides = db.prepare(`SELECT email, reason, marked_at, active FROM nonlead_overrides`).all();
  const nonleadMap = {};
  overrides.forEach(o => { nonleadMap[o.email.toLowerCase()] = o; });

  // Always use current price from DB — never trust cached lead_price
  const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
  const livePriceMap = {};
  currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

  const leads = (revenueCache.leads || []).map(l => {
    const o        = nonleadMap[(l.lead_email || '').toLowerCase()];
    const livePrice = livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
    return {
      ...l,
      lead_price:     livePrice,
      is_nonlead:     o?.active ? true  : false,
      nonlead_reason: o?.active ? o.reason   : '',
      nonlead_date:   o?.active ? o.marked_at: '',
    };
  });
  res.json({ ...revenueCache, leads });
});

// Mark lead as non-lead
app.post('/api/nonlead/mark', (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  db.prepare(`INSERT INTO nonlead_overrides (email, reason, active) VALUES (?, ?, 1)
    ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, marked_at=datetime('now'), active=1`)
    .run(email.toLowerCase(), reason || '');
  res.json({ ok: true });
});

// Restore lead to active
app.post('/api/nonlead/restore', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  db.prepare(`UPDATE nonlead_overrides SET active=0 WHERE email=?`).run(email.toLowerCase());
  res.json({ ok: true });
});

app.get('/api/revenue/stats-by-workspace', (req, res) => {
  // Always use current price from DB so changing a price reflects immediately
  const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
  const livePriceMap  = {};
  currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

  const counts = {};
  (revenueCache.leads || []).forEach(l => {
    if (!counts[l.workspace_id]) counts[l.workspace_id] = { delivered: 0, revenue: 0 };
    counts[l.workspace_id].delivered++;
    counts[l.workspace_id].revenue += livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
  });
  res.json(counts);
});

// ── Campaign intelligence cache (refreshed every 30 min) ─────
let campaignCache = { workspaces: [], targetingPatterns: [], optimisations: [], updatedAt: null };

function scoreCampaign(c, wsAvgReplyRate) {
  const sent = c.sent_count || 0;
  if (sent < 50) return { tier: 'new', replyRate: 0, posReplyRate: 0, leadRate: 0, flags: [] };
  const replyRate    = sent > 0 ? (c.replied_count || 0) / sent : 0;
  const posReplyRate = (c.replied_count || 0) > 0 ? (c.positive_reply_count || 0) / c.replied_count : 0;
  const leadRate     = (c.replied_count || 0) > 0 ? (c.lead_count || 0) / c.replied_count : 0;
  const contacted    = c.lead_contacted_count || 0;
  const total        = c.lead_count || 0;
  const exhaustion   = total > 0 ? contacted / total : 0;
  const flags = [];
  if (replyRate < 0.005 && sent > 300)  flags.push({ type: 'critical', msg: 'Very low reply rate — copy likely needs refreshing' });
  else if (replyRate < 0.01 && sent > 200) flags.push({ type: 'warning', msg: 'Below average reply rate' });
  if (wsAvgReplyRate > 0 && replyRate > wsAvgReplyRate * 1.5) flags.push({ type: 'top', msg: 'Top performer — 50%+ above workspace average' });
  if (posReplyRate > 0.4 && c.replied_count > 5) flags.push({ type: 'positive', msg: 'High quality — strong positive reply ratio' });
  if (c.bounced_count > 0 && sent > 0 && c.bounced_count / sent > 0.05) flags.push({ type: 'critical', msg: 'High bounce rate — check email list quality' });
  if (exhaustion >= 0.9) flags.push({ type: 'critical', msg: `Data exhausted — ${Math.round(exhaustion*100)}% of leads contacted, needs fresh data` });
  else if (exhaustion >= 0.75) flags.push({ type: 'warning', msg: `Data running low — ${Math.round(exhaustion*100)}% of leads contacted` });
  const tier = replyRate >= 0.025 ? 'top' : replyRate >= 0.01 ? 'good' : replyRate >= 0.005 ? 'warning' : 'critical';
  return { tier, replyRate, posReplyRate, leadRate, exhaustion, flags };
}

function analyzeVariants(steps) {
  const insights = [];
  for (const step of (steps || [])) {
    const vars = (step.variations || []).filter(v => v.sent >= 100);
    if (vars.length < 2) continue;
    vars.sort((a, b) => (b.reply / b.sent) - (a.reply / a.sent));
    const best  = vars[0];
    const worst = vars[vars.length - 1];
    const bestRate  = best.reply  / best.sent;
    const worstRate = worst.reply / worst.sent;
    if (bestRate > worstRate * 1.5 && bestRate > 0.005) {
      insights.push({
        step: step.step, winner: best.variation,
        winnerRate: (bestRate * 100).toFixed(1), loserRate: (worstRate * 100).toFixed(1),
        msg: `Step ${step.step}: Variant ${best.variation} (${(bestRate*100).toFixed(1)}%) outperforms Variant ${worst.variation} (${(worstRate*100).toFixed(1)}%) — consolidate around the winner`
      });
    }
  }
  return insights;
}

function parseApolloParams(name) {
  const match = (name || '').match(/https?:\/\/app\.apollo\.io[^\s]*/);
  if (!match) return null;
  try {
    const qPart = match[0].split('?')[1] || '';
    const p = new URLSearchParams(qPart);
    const get = key => p.getAll(key).map(v => decodeURIComponent(v).replace(/\+/g,' ').replace(/%2C/gi,',').trim());
    const sizeMap = {'1,10':'1-10','11,20':'11-20','21,50':'21-50','51,100':'51-100','101,200':'101-200','201,500':'201-500','501,1000':'501-1k','1001,5000':'1k-5k'};
    return {
      titles:    get('personTitles').slice(0,3),
      seniority: get('personSeniorities').slice(0,3),
      sizes:     get('organizationNumEmployeesRanges').map(s => sizeMap[s] || s),
      locations: [...new Set([...get('personLocations'), ...get('organizationLocations'), ...get('accounthqLocations')])].slice(0,4),
      inclKws:   get('qOrganizationKeywordTags').slice(0,5),
    };
  } catch { return null; }
}

function analyzeTargetingPatterns(workspaces) {
  const groups = {};
  for (const ws of workspaces) {
    for (const c of ws.campaigns) {
      if (c.sent < 200 || c.replyRate === 0) continue;
      const a = parseApolloParams(c.name);
      if (!a) continue;
      const titleKey  = (a.titles.length ? a.titles : a.seniority).slice(0,2).join(', ') || '';
      const sizeKey   = a.sizes.slice(0,2).join(', ') || '';
      const kwKey     = a.inclKws.slice(0,3).join(', ') || '';
      const key       = [titleKey, sizeKey, kwKey].filter(Boolean).join(' | ');
      if (!key) continue;
      if (!groups[key]) groups[key] = { label: key, titleKey, sizeKey, kwKey, campaigns: [], totalSent: 0, totalReplies: 0 };
      groups[key].campaigns.push({ wsName: ws.name, name: c.name.replace(/https?:\/\/\S+/g,'').trim().slice(0,50), replyRate: c.replyRate, sent: c.sent, tier: c.tier });
      groups[key].totalSent    += c.sent;
      groups[key].totalReplies += c.replies;
    }
  }
  return Object.values(groups)
    .filter(g => g.campaigns.length >= 2)
    .map(g => ({ ...g, avgReplyRate: g.totalSent > 0 ? g.totalReplies / g.totalSent : 0, count: g.campaigns.length }))
    .sort((a, b) => b.avgReplyRate - a.avgReplyRate);
}

function generateOptimisations(workspaces) {
  const opts = [];
  for (const ws of workspaces) {
    for (const c of ws.campaigns) {
      if (c.status !== 'ACTIVE') continue;
      for (const step of (c.variationSteps || [])) {
        const active = (step.variations || []).filter(v => v.is_active !== false && v.sent >= 50);
        if (active.length < 2) continue;
        active.sort((a, b) => (b.reply / b.sent) - (a.reply / a.sent));
        const winner = active[0];
        const winnerRate = winner.reply / winner.sent;
        const losers = active.slice(1).filter(v => {
          const lr = v.reply / v.sent;
          return winnerRate >= lr * 2 && winner.reply >= 5 && winner.sent >= 300;
        });
        if (!losers.length) continue;
        opts.push({
          wsId: ws.id, wsName: ws.name,
          campId: c.id, campName: c.name.replace(/https?:\/\/\S+/g,'').trim().slice(0,60) || c.name.slice(0,60),
          step: step.step,
          winner: { variation: winner.variation, sent: winner.sent, reply: winner.reply, rate: winnerRate },
          losers: losers.map(v => ({ variation: v.variation, sent: v.sent, reply: v.reply, rate: v.reply / v.sent })),
          confidence: winner.sent >= 500 && winner.reply >= 10 ? 'high' : 'medium',
          applied: false,
        });
      }
    }
  }
  return opts;
}

async function refreshCampaignCache() {
  try {
    const wsRaw = await pvFetch('/workspaces');
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || []);

    // Only scan active clients — inactive ones are excluded from intelligence
    const clientRows = db.prepare(`SELECT workspace_id, client_status FROM clients`).all();
    const inactiveIds = new Set(clientRows.filter(r => r.client_status === 'inactive').map(r => r.workspace_id));

    const result = [];

    for (const ws of workspaces) {
      if (inactiveIds.has(ws.id)) continue; // skip inactive clients
      try {
        const campaigns = await pvFetch(`/campaign/list-all?workspace_id=${ws.id}`);
        if (!Array.isArray(campaigns) || !campaigns.length) continue;
        const active = campaigns.filter(c => (c.sent_count || 0) >= 50);
        const wsAvgReplyRate = active.length
          ? active.reduce((s, c) => s + (c.replied_count || 0) / (c.sent_count || 1), 0) / active.length : 0;

        const scored = [];
        for (const c of campaigns) {
          const metrics = scoreCampaign(c, wsAvgReplyRate);
          let variantInsights = [], variationSteps = [];
          if ((c.sent_count || 0) >= 300) {
            try {
              const vstats = await pvFetch(`/campaign/get/variation-stats?campaign_id=${c.id}&workspace_id=${ws.id}`);
              if (Array.isArray(vstats)) { variationSteps = vstats; variantInsights = analyzeVariants(vstats); }
            } catch {}
          }
          // Step drop-off: replies per step
          const stepReplies = (variationSteps || []).map(st => ({
            step: st.step,
            sent:    st.variations.reduce((s, v) => s + (v.sent || 0), 0),
            replies: st.variations.reduce((s, v) => s + (v.reply || 0), 0),
          }));

          scored.push({
            id: c.id, name: c.camp_name || 'Unnamed', status: c.status,
            sent: c.sent_count || 0, opens: c.unique_opened_count || c.opened_count || 0,
            replies: c.replied_count || 0, posReplies: c.positive_reply_count || 0,
            negReplies: c.negative_reply_count || 0, bounces: c.bounced_count || 0,
            leads: c.lead_count || 0, leadContacted: c.lead_contacted_count || 0,
            openRate: c.open_rate || 0, replyRate: metrics.replyRate,
            posReplyRate: metrics.posReplyRate, leadRate: metrics.leadRate,
            exhaustion: metrics.exhaustion, tier: metrics.tier, flags: metrics.flags,
            variantInsights, variationSteps, stepReplies,
            lastSent: c.last_lead_sent || null, lastReplied: c.last_lead_replied || null,
          });
        }
        scored.sort((a, b) => b.replyRate - a.replyRate);
        result.push({
          id: ws.id, name: ws.name || ws.workspace_name,
          avgReplyRate: wsAvgReplyRate, campaigns: scored,
          totalSent:    scored.reduce((s, c) => s + c.sent, 0),
          totalReplies: scored.reduce((s, c) => s + c.replies, 0),
          totalLeads:   scored.reduce((s, c) => s + c.leads, 0),
          activeCampaigns: scored.filter(c => c.status === 'ACTIVE').length,
        });
      } catch (e) { console.warn(`[campaign cache] ${ws.name} error:`, e.message); }
    }

    const targetingPatterns = analyzeTargetingPatterns(result);
    const optimisations     = generateOptimisations(result);

    campaignCache = { workspaces: result, targetingPatterns, optimisations, updatedAt: new Date().toISOString() };
    console.log(`[campaign cache] refreshed — ${result.length} ws, ${result.reduce((s,w)=>s+w.campaigns.length,0)} campaigns, ${optimisations.length} optimisations, ${targetingPatterns.length} targeting patterns`);
  } catch (err) { console.error('[campaign cache] refresh failed:', err.message); }
}

// Refresh on startup then every 30 minutes
refreshCampaignCache();
setInterval(refreshCampaignCache, 30 * 60 * 1000);

app.get('/api/campaigns/intelligence', (req, res) => res.json(campaignCache));

// Apply variant optimisation — pauses losing variants via PlusVibe
app.post('/api/campaigns/apply-optimisation', requireAdmin, async (req, res) => {
  const { wsId, campId, step, loserVariations } = req.body;
  if (!wsId || !campId || !step || !loserVariations?.length)
    return res.status(400).json({ error: 'Missing params' });
  try {
    // Get current campaign sequence structure
    const campaigns = await pvFetch(`/campaign/list-all?workspace_id=${wsId}`);
    const camp = (Array.isArray(campaigns) ? campaigns : []).find(c => c.id === campId);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });

    // Build updated sequences with losing variants deactivated
    const sequences = (camp.sequences || []).map(seq => {
      if (seq.seq_number !== step && seq.step !== step) return seq;
      return {
        ...seq,
        variants: (seq.variants || seq.variations || []).map(v => ({
          ...v,
          is_active: loserVariations.includes(v.variation) ? false : v.is_active
        }))
      };
    });

    const r = await fetch(`https://api.plusvibe.ai/api/v1/campaign/update/campaign`, {
      method: 'PATCH',
      headers: { 'x-api-key': PLUSVIBE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: wsId, id: campId, sequences })
    });
    const result = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: result.message || 'PlusVibe error', raw: result });
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PlusVibe proxy (kept for performance.html agency scan) ────
app.get('/api/pv/workspaces', async (req, res) => {
  try {
    const r = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
      headers: { 'x-api-key': PLUSVIBE_KEY }
    });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pv/workspace-leads', async (req, res) => {
  const { workspace_id, label, page, limit } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });
  try {
    const qs = new URLSearchParams({ workspace_id, page: page || 1, limit: limit || 100 });
    if (label) qs.set('label', label);
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
    'SELECT id, username, workspace_id, workspace_name, plan_leads, price_per_lead, stripe_customer_id, contact_name, contact_email, contact_phone, website, notes, client_status, restart_date, created_at FROM clients ORDER BY created_at DESC'
  ).all());
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { username, password, workspace_id, workspace_name, plan_leads, price_per_lead,
          contact_name, contact_email, contact_phone, website, notes } = req.body || {};
  if (!username || !password || !workspace_id || !workspace_name)
    return res.status(400).json({ error: 'All fields required' });
  try {
    db.prepare(
      'INSERT INTO clients (username, password_hash, workspace_id, workspace_name, plan_leads, price_per_lead, contact_name, contact_email, contact_phone, website, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(username, bcrypt.hashSync(password, 10), workspace_id, workspace_name,
         parseInt(plan_leads) || 0, parseFloat(price_per_lead) || 0,
         contact_name || '', contact_email || '', contact_phone || '', website || '', notes || '');
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Username already exists' }); }
});

app.put('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const { plan_leads, price_per_lead, contact_name, contact_email, contact_phone, website, notes, client_status, restart_date } = req.body || {};
  const updates = [];
  const vals = [];
  if (plan_leads     !== undefined) { updates.push('plan_leads = ?');     vals.push(parseInt(plan_leads) || 0); }
  if (price_per_lead !== undefined) { updates.push('price_per_lead = ?'); vals.push(parseFloat(price_per_lead) || 0); }
  if (contact_name   !== undefined) { updates.push('contact_name = ?');   vals.push(contact_name); }
  if (contact_email  !== undefined) { updates.push('contact_email = ?');  vals.push(contact_email); }
  if (contact_phone  !== undefined) { updates.push('contact_phone = ?');  vals.push(contact_phone); }
  if (website        !== undefined) { updates.push('website = ?');        vals.push(website); }
  if (notes          !== undefined) { updates.push('notes = ?');          vals.push(notes); }
  if (client_status  !== undefined) { updates.push('client_status = ?');  vals.push(client_status); }
  if (restart_date   !== undefined) { updates.push('restart_date = ?');   vals.push(restart_date || null); }
  if (updates.length)
    db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
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
