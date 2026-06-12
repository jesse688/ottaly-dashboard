'use strict';
/**
 * routes/client-portal.js
 * Client-facing endpoints (requireAuth / JWT):
 *   /api/stats, /api/leads, /api/stripe/checkout, /api/stripe/portal,
 *   /api/agency/leads, /api/client-status (GET), /api/workspace-prices.
 *
 * Extracted from server.js lines ~1951–2325.
 * Mounted with: app.use('/', clientPortalRoutes(ctx));
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {object}   ctx.stripe
 * @param {object}   ctx.Sentry
 * @param {object}   ctx.apiCache
 * @param {string}   ctx.APP_URL
 * @param {string}   ctx.PLUSVIBE_KEY
 * @param {Function} ctx.requireAuth
 * @param {Function} ctx.requireSession
 * @param {Function} ctx.requireAdmin
 * @param {object}   ctx.performanceCache    - for /api/leads/analysis
 * @param {Function} ctx.fetchPerformanceLabeledLeads
 * @param {Function} ctx.isPvNonLeadLabel
 * @param {number}   ctx.PERF_LEADS_TTL_MS
 */
function makeRouter(ctx) {
  const {
    db, stripe, Sentry, apiCache,
    APP_URL, PLUSVIBE_KEY,
    requireAuth, requireSession, requireAdmin,
    performanceCache, fetchPerformanceLabeledLeads,
    isPvNonLeadLabel, PERF_LEADS_TTL_MS,
  } = ctx;

  const router = express.Router();

  // ── Client stats ───────────────────────────────────────────
  router.get('/api/stats', requireAuth, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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
  router.get('/api/leads', requireAuth, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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

  // ── Leads analysis (admin/manager view) ───────────────────
  router.get('/api/leads/analysis', requireSession, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    let raw = [];
    try {
      const cached = performanceCache?.labeledLeads?.get(workspace_id);
      if (cached && Date.now() - cached.savedAt < PERF_LEADS_TTL_MS) {
        raw = cached.data || [];
      } else {
        raw = await fetchPerformanceLabeledLeads(workspace_id);
      }
    } catch(e) {
      return res.status(502).json({ error: 'PlusVibe fetch failed: ' + e.message });
    }

    function cv(lead, key) {
      const vars = lead.custom_variables || lead.customVariables;
      if (!vars) return null;
      if (Array.isArray(vars)) {
        const found = vars.find(v => String(v.name||v.key||'').toLowerCase() === key.toLowerCase());
        return found ? String(found.value || '').trim() || null : null;
      }
      if (typeof vars === 'object') {
        const val = vars[key] || vars[key.toLowerCase()];
        return val ? String(val).trim() || null : null;
      }
      return null;
    }

    function empBucket(lead) {
      const n = parseInt(lead.num_employees || lead.estimated_num_employees || cv(lead, 'num_employees') || cv(lead, 'estimated_num_employees') || 0, 10);
      if (!n) return null;
      if (n <= 10)   return '1–10';
      if (n <= 50)   return '11–50';
      if (n <= 200)  return '51–200';
      if (n <= 500)  return '201–500';
      if (n <= 1000) return '501–1,000';
      if (n <= 5000) return '1,001–5,000';
      return '5,000+';
    }

    const qualifiedLeads = raw.filter(l => !isPvNonLeadLabel(l.label) && !l._pv_nonlead);
    const emails = [...new Set(qualifiedLeads.map(l => (l.email||'').toLowerCase()).filter(Boolean))];

    const pgMap = {};
    const pgdb = req.app.locals.pgDb;
    if (pgdb && emails.length) {
      try {
        const { rows: contacts } = await pgdb.query(
          `SELECT LOWER(email) AS email, seniority, num_employees, department, sub_departments, job_title_cleaned
           FROM contacts WHERE LOWER(email) = ANY($1::text[])`,
          [emails]
        );
        contacts.forEach(c => { pgMap[c.email] = c; });
      } catch(e) { console.warn('[leads/analysis] contacts enrich failed:', e.message); }
    }

    const subjectMap = {};
    if (pgdb && emails.length) {
      try {
        const { rows: subRows } = await pgdb.query(
          `SELECT DISTINCT ON (LOWER(ee.lead_email))
             LOWER(ee.lead_email) AS email, t.subject, t.body_excerpt AS snippet
           FROM email_events ee
           JOIN campaign_templates ct ON ct.content_hash = ee.content_hash AND ct.workspace_id = $1
           JOIN templates t ON t.content_hash = ee.content_hash
           WHERE LOWER(ee.lead_email) = ANY($2::text[])
             AND ee.event_type IN ('interested','lead','positive_reply','reply')
             AND t.subject IS NOT NULL
           ORDER BY LOWER(ee.lead_email), ee.event_at DESC`,
          [workspace_id, emails]
        );
        subRows.forEach(r => { subjectMap[r.email] = { subject: r.subject || '', snippet: r.snippet || '' }; });
      } catch(e) { console.warn('[leads/analysis] subject enrich failed:', e.message); }
    }

    const sqMap = {};
    try {
      db.prepare('SELECT data FROM leads WHERE workspace_id = ?').all(workspace_id).forEach(row => {
        try {
          const d = JSON.parse(row.data);
          if (d.email) sqMap[d.email.toLowerCase()] = {
            subject: d.last_lead_reply_subject || d.latest_subject || d.subject || '',
            snippet: (d.text_body || d.last_lead_reply || d.latest_message || '').slice(0, 200),
          };
        } catch {}
      });
    } catch {}

    const leads = qualifiedLeads.map(l => {
      const email = (l.email||'').toLowerCase();
      const pg = pgMap[email] || {};
      const sub = subjectMap[email] || sqMap[email] || {};
      return {
        id:           l._id || l.id || l.email,
        first_name:   l.first_name  || l.firstName  || '',
        last_name:    l.last_name   || l.lastName   || '',
        email:        l.email || '',
        company_name: l.company_name || l.companyName || '',
        job_title:    l.job_title || l.title || pg.job_title_cleaned || cv(l, 'job_title') || '',
        industry:     l.industry  || cv(l, 'industry')  || '',
        seniority:    l.seniority || pg.seniority || cv(l, 'seniority') || '',
        department:   l.department|| pg.department|| cv(l, 'department')|| '',
        company_size: empBucket(l) || (pg.num_employees ? empBucket({ num_employees: pg.num_employees }) : ''),
        city:         l.city    || cv(l, 'city')    || '',
        country:      l.country || cv(l, 'country') || '',
        campaign:     l.camp_name || l.campaign_name || l.campaignName || '',
        subject:      sub.subject || '',
        snippet:      (sub.snippet || '').slice(0, 200),
        label:        l.label || '',
        date:         l._pv_lead_date || l.lead_date || l.updatedAt || l.created_at || '',
      };
    });

    res.json({ total: leads.length, leads });
  });

  // ── Set closed deal value ──────────────────────────────────
  router.post('/api/leads/:id/value', requireAuth, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const row = db.prepare('SELECT id FROM leads WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.client.workspace_id);
    if (!row) return res.status(404).json({ error: 'Lead not found' });
    const value = parseFloat(req.body?.value);
    if (isNaN(value) || value < 0) return res.status(400).json({ error: 'Invalid value' });
    db.prepare('UPDATE leads SET closed_value = ? WHERE id = ?').run(value, req.params.id);
    res.json({ ok: true });
  });

  // ── Submit non-lead request ────────────────────────────────
  router.post('/api/leads/:id/nonlead', requireAuth, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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
  router.get('/api/leads/:id/thread', requireAuth, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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
  router.post('/api/leads/:id/reply', requireAuth, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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
  router.post('/api/stripe/checkout', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const qty = parseInt(req.body?.leads_count);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
    if (!c.price_per_lead) return res.status(400).json({ error: 'No price configured for this account. Contact support.' });

    try {
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
    } catch (err) {
      console.error('[stripe/checkout]', err);
      Sentry.captureException(err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Stripe customer portal ─────────────────────────────────
  router.post('/api/stripe/portal', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const c = db.prepare('SELECT stripe_customer_id FROM clients WHERE id = ?').get(req.client.id);
    if (!c?.stripe_customer_id)
      return res.status(400).json({ error: 'No billing account yet. Make a purchase first.' });
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer:   c.stripe_customer_id,
        return_url: `${APP_URL}/client.html`,
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('[stripe/portal]', err);
      Sentry.captureException(err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Agency lead counts ─────────────────────────────────────
  router.get('/api/agency/leads', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
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

  // ── Client status (read-only for all session roles) ────────
  router.get('/api/client-status', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const cacheKey = 'client_status';
    const cached = apiCache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);
    const rows = db.prepare(`SELECT workspace_id, workspace_name, client_status, restart_date FROM clients`).all();
    apiCache.set(cacheKey, rows, 30);
    res.json(rows);
  });

  // ── Workspace prices ────────────────────────────────────────
  router.get('/api/workspace-prices', requireSession, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const cacheKey = 'workspace_prices';
    const cached = apiCache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);
    const rows = db.prepare(`SELECT workspace_id, workspace_name, price_per_lead, client_status, contact_name, campaign_manager, campaign_manager_2, commission_rate, manager_start_date FROM clients`).all();
    apiCache.set(cacheKey, rows, 60);
    res.json(rows);
  });

  return router;
}

module.exports = makeRouter;
