'use strict';
/**
 * routes/webhooks.js
 * Webhook receivers:
 *   POST /api/stripe/webhook  — Stripe (raw body, before express.json)
 *   POST /webhook/lead        — N8n lead ingest
 *   POST /api/slack/slash     — Slack slash command
 *
 * NOTE: /webhook/plusvibe-reply is NOT extracted here because it relies
 * on hundreds of lines of reply-intelligence logic defined in server.js.
 * That handler remains in server.js until those helpers are also modularised.
 *
 * Mounted with: app.use('/', webhookRoutes(ctx));
 * IMPORTANT: Mount BEFORE express.json() middleware so the Stripe route
 * can receive the raw body.
 */
const express = require('express');

/**
 * @param {object} ctx
 * @param {object}   ctx.db
 * @param {object}   ctx.stripe
 * @param {string}   ctx.STRIPE_WEBHOOK_SECRET
 * @param {object}   ctx.verifySlackRequest   - from slack-slash module
 * @param {Function} ctx.callClaude           - from slack-slash module
 */
function makeRouter(ctx) {
  const {
    db, stripe,
    STRIPE_WEBHOOK_SECRET,
    verifySlackRequest, callClaude,
  } = ctx;

  const router = express.Router();

  // ── Stripe webhook (raw body required) ────────────────────
  router.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET)
      return res.status(503).json({ error: 'Stripe webhook not configured' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (event.type === 'checkout.session.completed' && db) {
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

  // ── N8n lead ingest ────────────────────────────────────────
  // LEAD_WEBHOOK_SECRET is read directly from env — not passed in ctx —
  // since it's only used here and is intentionally lightweight.
  router.post('/webhook/lead', (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const secret = process.env.LEAD_WEBHOOK_SECRET || '';
    if (secret) {
      const provided = req.headers['x-webhook-secret'] || '';
      if (provided !== secret)
        return res.status(401).json({ error: 'Unauthorized' });
    }
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

  // ── Slack slash command ────────────────────────────────────
  router.post('/api/slack/slash',
    express.raw({ type: 'application/x-www-form-urlencoded' }),
    async (req, res) => {
      const rawBody = req.body.toString();
      const params = new URLSearchParams(rawBody);
      const body = Object.fromEntries(params);

      console.log('[slack-slash] Received:', body.command, body.text);

      if (!verifySlackRequest(rawBody, req.headers)) {
        console.error('[slack-slash] Invalid signature');
        return res.status(401).send('Unauthorized');
      }

      const { text, user_id, response_url } = body;
      if (!text) return res.json({ response_type: 'ephemeral', text: 'Usage: /agent <your question>' });

      res.json({ response_type: 'ephemeral', text: '_Thinking..._' });

      try {
        const reply = await callClaude(text);
        const respPayload = JSON.stringify({ response_type: 'in_channel', text: `<@${user_id}>: ${text}\n\n${reply}` });
        const url = new URL(response_url);
        const respReq = require('https').request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respPayload) },
        });
        respReq.write(respPayload);
        respReq.end();
      } catch (err) {
        console.error('[slack-slash] Error:', err.message);
      }
    }
  );

  return router;
}

module.exports = makeRouter;
