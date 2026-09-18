/**
 * Bounce webhook receiver.
 *
 * PlusVibe can POST every bounce as it happens (event type `BOUNCED_EMAIL`,
 * shown in the UI as "All Bounced Emails"), which beats polling on both counts:
 * it arrives immediately rather than up to an hour later, and it costs no API
 * calls against the shared PV gate.
 *
 * Webhooks only cover NEW bounces. The polling ingest stays useful for history
 * and as a safety net — a webhook that silently stops looks exactly like a
 * quiet period, so `last_webhook_at` is tracked and the dashboard can say when
 * one was last seen.
 *
 * Needs a public HTTPS URL, so in production this runs wherever the mailbox
 * system is deployed, not on localhost.
 */

const crypto = require('crypto');
const { classify, statusCode } = require('./bounce');

/**
 * Pull the fields we need out of a webhook payload.
 *
 * The real shape, captured from a live BOUNCED_EMAIL webhook on 2026-09-18:
 *
 *   { webhook_event: 'BOUNCED_EMAIL', workspace_id, workspace_name,
 *     camp_id, campaign_id, campaign_name, is_camp_paused, date,
 *     sender_email, sender_mx, lead_email, lead_mx, is_verified,
 *     msg, bounce_type }
 *
 * It does NOT match `list_all_leads`. The bounce text is `msg`, not
 * `bounce_msg`; the sending mailbox is `sender_email`, not an account id; and
 * there is NO lead id at all, which matters because that was the primary key
 * used to deduplicate polled bounces. A synthetic key is derived instead —
 * see syntheticId().
 *
 * `list_all_leads` field names are still accepted so the same code can store a
 * polled bounce and a pushed one.
 */
function extract(body) {
  const b = body || {};
  const src = b.lead || b.data || b.payload || b;
  const pick = (...keys) => {
    for (const k of keys) {
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k];
      if (b[k] !== undefined && b[k] !== null && b[k] !== '') return b[k];
    }
    return null;
  };
  return {
    lead_id: pick('_id', 'lead_id', 'id', 'leadId'),
    // `msg` is what the webhook sends; the rest are the polled shape.
    bounce_msg: pick('msg', 'bounce_msg', 'bounceMsg', 'bounce_message', 'message', 'reason'),
    bounce_type: pick('bounce_type', 'bounceType', 'type'),
    recipient: pick('lead_email', 'email', 'to', 'recipient'),
    account_id: pick('email_account_id', 'emailAccountId', 'account_id', 'from_account_id'),
    // The webhook identifies the sending mailbox by ADDRESS, not by id.
    account_email: pick('sender_email', 'email_acc_name', 'from', 'sender', 'account_email'),
    workspace_id: pick('workspace_id', 'workspaceId'),
    workspace_name: pick('workspace_name', 'workspaceName'),
    bounced_at: pick('date', 'modified_at', 'bounced_at', 'timestamp', 'created_at'),
    campaign_id: pick('camp_id', 'campaign_id'),
  };
}

/**
 * A stable id for a bounce that arrived without one.
 *
 * The webhook carries no lead id, but bounce_event is keyed on one so the same
 * bounce cannot be stored twice. Hashing the fields that identify the event —
 * sender, recipient, timestamp, message — gives the same key if PlusVibe
 * redelivers it, and a different key for a genuinely new bounce.
 *
 * Prefixed so a synthetic key is never confused with a real PlusVibe id, and
 * so a later poll of the same bounce inserts under its real id rather than
 * colliding. That means a bounce can be stored twice — once from the webhook,
 * once from the poll — which is the safe direction: a duplicate is visible and
 * fixable, a silently dropped bounce is not.
 */
function syntheticId(f) {
  const basis = [f.account_email, f.recipient, f.bounced_at, f.bounce_msg]
    .map((x) => String(x || '')).join('|');
  return 'wh_' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
}

/** PlusVibe sends a sample payload when a webhook is created. Not a real bounce. */
function isTestPayload(f, body) {
  return /John Doe Workspace/i.test(String(body?.workspace_name || ''))
    || /yourcompany\.com$/i.test(String(f.account_email || ''))
    || /nonexistent-domain\.com$/i.test(String(f.recipient || ''));
}

/** Verify the shared secret, if one is configured. */
function verify(req, secret) {
  if (!secret) return true;                    // no secret set, nothing to check
  const sig = req.headers['x-webhook-signature']
    || req.headers['x-plusvibe-signature']
    || req.headers['x-signature'];
  if (!sig) return false;
  const body = JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  // Compare in constant time, and tolerate a "sha256=" prefix.
  const given = String(sig).replace(/^sha256=/, '');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Store one bounce. Returns what was classified, so the caller can log it.
 * Idempotent: the same lead_id arriving twice updates rather than duplicates.
 */
function store(db, payload, { rawBody = null } = {}) {
  const f = extract(payload);

  // PlusVibe posts a sample payload when a webhook is created. Storing it
  // would put a fake bounce against a mailbox that does not exist.
  if (isTestPayload(f, payload)) {
    return { stored: false, reason: 'PlusVibe test payload, ignored', test: true };
  }
  if (!f.bounce_msg) return { stored: false, reason: 'no bounce message in payload' };

  // The webhook has no lead id, so one is derived from the event's own fields.
  const leadId = f.lead_id || syntheticId(f);

  // Resolve the SENDING mailbox. The webhook gives an address; a polled bounce
  // gives an account id. Accept either.
  let email = null;
  if (f.account_id) {
    const row = db.prepare(`SELECT email FROM mailbox WHERE pv_id = ?`).get(f.account_id);
    if (row) email = row.email;
  }
  if (!email && f.account_email && String(f.account_email).includes('@')) {
    email = String(f.account_email).toLowerCase();
  }

  const workspace = (() => {
    if (email) {
      const w = db.prepare(`SELECT workspace_name FROM mailbox WHERE email = ?`).get(email);
      if (w) return w.workspace_name;
    }
    if (f.workspace_id) {
      const w = db.prepare(`SELECT workspace_name FROM mailbox WHERE workspace_id = ? LIMIT 1`)
                  .get(f.workspace_id);
      if (w) return w.workspace_name;
    }
    // Fall back to the name the webhook carries, so a bounce from a mailbox we
    // have not ingested yet is still attributed to a client.
    return f.workspace_name || null;
  })();

  const cause = classify(f.bounce_msg);
  db.prepare(`
    INSERT INTO bounce_event (lead_id, email, workspace, recipient, bounced_at,
      bounce_type, status_code, cause, action, bounce_msg)
    VALUES (@lead_id, @email, @workspace, @recipient, @bounced_at,
      @bounce_type, @status_code, @cause, @action, @bounce_msg)
    ON CONFLICT(lead_id) DO UPDATE SET
      cause=excluded.cause, action=excluded.action,
      status_code=excluded.status_code, bounce_msg=excluded.bounce_msg
  `).run({
    lead_id: leadId,
    email,
    workspace,
    recipient: f.recipient,
    bounced_at: f.bounced_at || new Date().toISOString(),
    bounce_type: f.bounce_type,
    status_code: statusCode(f.bounce_msg),
    cause: cause.key,
    action: cause.action,
    bounce_msg: f.bounce_msg,
  });

  // An unclassified bounce from a live webhook is worth seeing immediately:
  // it means a rule is missing while bounces are actively arriving.
  return {
    stored: true, cause: cause.key, action: cause.action,
    email, workspace, unmatched: cause.key === 'unknown',
    synthetic_id: !f.lead_id,
    // A bounce whose sender we cannot resolve is stored anyway, but flagged:
    // it means the mailbox is not in our roster yet.
    unresolved_sender: !email,
    raw_kept: !!rawBody,
  };
}

/** Express handler. Mount at a public HTTPS path. */
function handler(getDb, { secret = process.env.PV_WEBHOOK_SECRET, log = console.error } = {}) {
  return (req, res) => {
    if (!verify(req, secret)) {
      log('[bounce-webhook] rejected: bad signature');
      return res.status(401).json({ error: 'bad signature' });
    }
    try {
      const out = store(getDb(), req.body);
      if (out.unmatched) {
        log('[bounce-webhook] UNCLASSIFIED: '
          + String(req.body?.bounce_msg || '').slice(0, 120));
      }
      // Always 200 on a payload we understood: a webhook sender that sees an
      // error will usually retry, and a retry storm helps nobody.
      res.json({ ok: true, ...out });
    } catch (e) {
      log('[bounce-webhook] ' + e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

module.exports = { handler, store, extract, verify, syntheticId, isTestPayload };
