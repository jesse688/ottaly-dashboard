import pool from './db'
import { getBalance, getLockedLeadIds, reconcileLeadCharges } from './balance'
import { getEmails } from './plusvibe'

const FROM = process.env.EMAIL_FROM || 'Ottaly <info@ottaly.co.uk>'
// BCC'd on every client lead notification so the agency keeps a copy WITHOUT the client
// seeing it. Overridable via env. IMPORTANT: this must NOT equal the From sender address
// (info@ottaly.co.uk) — providers suppress a self-addressed copy, which is why info@
// never received it. Default to a distinct monitoring alias; set LEAD_NOTIFY_BCC in env.
const LEAD_NOTIFY_BCC = process.env.LEAD_NOTIFY_BCC || 'jamie@ottaly.co.uk'
const BASE_URL = (process.env.PORTAL_BASE_URL || 'https://login.ottaly.co.uk').replace(/\/$/, '')

// Default notification templates (editable in admin → portal_settings).
// {lead_message} = what the lead actually wrote (normal email only; locked email
// never includes it so out-of-credit leads stay private).
export const DEFAULT_TEMPLATES = {
  notif_subject: 'Ottaly — New Lead',
  notif_body:
    'Hi {first_name},\n\nYou have a new lead 🎉 — {lead_name}{lead_company}.\n\nWhat they said:\n"{lead_message}"\n\nLog in to reply. Your lead balance is now {balance}.\n\n{login_url}\n\nBest,\nThe Ottaly Team',
  notif_locked_subject: 'Ottaly — New Lead (locked)',
  notif_locked_body:
    "Hi {first_name},\n\nA new lead just came in — but you're out of leads, so it's locked 🔒. Top up and it unlocks straight away.\n\n{login_url}/invoices\n\nBest,\nThe Ottaly Team",
  invoice_subject: 'Ottaly — New Invoice',
  invoice_body:
    'Hi {first_name},\n\nYou have a new invoice: {description} — {amount}.\n\nLog in to view and pay it:\n{login_url}/invoices\n\nBest,\nThe Ottaly Team',
  // 4th client email: access-code reset (sent from /api/forgot). {reset_url} is
  // the invite link they click to choose a new code.
  reset_subject: 'Reset your Ottaly access code',
  reset_body:
    "Hi,\n\nYou asked to reset your Ottaly login code.\n\nChoose a new code here (link expires after use):\n{reset_url}\n\nIf you didn't request this, you can ignore this email.\n\nBest,\nThe Ottaly Team",
  // Sent to the client when a lead replies AFTER the client has already sent a message.
  lead_reply_subject: '{lead_name} replied to your message',
  lead_reply_body:
    'Hi {first_name},\n\n{lead_name} has replied to your message:\n\n"{lead_preview}"\n\nLog in to view the full thread and reply:\n{login_url}/leads\n\nBest,\nThe Ottaly Team',
}
export type TemplateKey = keyof typeof DEFAULT_TEMPLATES

// Read all notification settings, merged over the defaults.
export async function getTemplates(): Promise<Record<TemplateKey, string>> {
  const r = await pool.query(`SELECT key, value FROM portal_settings WHERE key = ANY($1)`, [Object.keys(DEFAULT_TEMPLATES)])
  const out = { ...DEFAULT_TEMPLATES }
  for (const row of r.rows) if (row.value != null) out[row.key as TemplateKey] = row.value as string
  return out
}

function firstName(contactName: string | null, companyName: string | null): string {
  return (contactName || companyName || '').trim().split(/\s+/)[0] || 'there'
}

// Escape HTML so lead-controlled content (names, messages) can never inject
// markup into the email we send.
function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Fill {merge_tags} in a template string (values HTML-escaped).
function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''))
}

// Render a single subject+body template pair (admin-editable, merged over
// defaults). Used by the forgot-code flow for the reset email.
export async function renderTemplatePair(
  subjectKey: TemplateKey, bodyKey: TemplateKey, vars: Record<string, string>,
): Promise<{ subject: string; body: string }> {
  const tpl = await getTemplates()
  return { subject: render(tpl[subjectKey], vars), body: render(tpl[bodyKey], vars) }
}

// Low-level send via Resend. No-ops (logs) if RESEND_API_KEY isn't configured.
export async function sendEmail(to: string, subject: string, text: string, idempotencyKey?: string, bcc?: string): Promise<{ ok: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping send'); return { ok: false, reason: 'no_api_key' } }
  if (!to) return { ok: false, reason: 'no_recipient' }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    // BCC (not CC) so the agency gets a copy WITHOUT the client seeing it. Skip if it
    // equals the To. NOTE: a BCC that equals the From sender address is suppressed by
    // most providers (you don't inbox your own mail) — so the From address and the
    // monitoring inbox must DIFFER (e.g. From=info@, BCC=leads@ or an alias).
    const bccTo = bcc && bcc.toLowerCase() !== to.toLowerCase() ? bcc : undefined
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: FROM, to, ...(bccTo ? { bcc: bccTo } : {}), subject, html: text.replace(/\n/g, '<br>') }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { const body = await res.text(); console.error('[email] resend error:', res.status, body); return { ok: false, reason: `resend_${res.status}` } }
    return { ok: true }
  } catch (err) {
    console.error('[email] send failed:', err)
    return { ok: false, reason: 'exception' }
  }
}

// Send a reply email via Resend with optional file attachments.
// Used when a client replies from the portal — Bison doesn't support attachments,
// so attached files force the send through Resend directly.
export async function sendEmailReply(opts: {
  to: string; cc?: string; subject: string; html: string; text: string
  replyTo?: string
  // The mailbox the lead was contacted from. A client reply MUST go out from the
  // client's own identity (white-label), NEVER from Ottaly's info@ address — a
  // lead seeing "Ottaly <info@ottaly.co.uk>" reply to their cold email exposes the
  // backend and breaks the thread. When set, this overrides the default From.
  from?: string
  attachments?: { filename: string; content: Buffer }[]
}): Promise<{ ok: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping send'); return { ok: false, reason: 'no_api_key' } }
  if (!opts.to) return { ok: false, reason: 'no_recipient' }
  try {
    const payload: Record<string, unknown> = {
      from: opts.from || FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }
    if (opts.cc) payload.cc = opts.cc
    if (opts.replyTo) payload.reply_to = opts.replyTo
    if (opts.attachments?.length) {
      payload.attachments = opts.attachments.map(a => ({
        filename: a.filename,
        content: a.content.toString('base64'),
      }))
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { const body = await res.text(); console.error('[email] resend reply error:', res.status, body); return { ok: false, reason: `resend_${res.status}` } }
    return { ok: true }
  } catch (err) {
    console.error('[email] sendEmailReply failed:', err)
    return { ok: false, reason: 'exception' }
  }
}

// Notify the client when a lead replies AFTER the client has already sent a message.
// Only fires once per (lead_email, workspace) conversation thread — deduped via portal_meta.
export async function notifyClientOfLeadReply(workspaceId: string, leadEmail: string, leadName: string, preview: string, replyId?: string | null): Promise<void> {
  try {
    // Dedup PER REPLY (not per thread) so every new reply from the lead notifies —
    // a thread-level key would only ever fire on the first reply. Fall back to a
    // timestamped key when we have no reply id so we still don't spam on retries.
    const dedupKey = replyId
      ? `lead_reply_notif_${workspaceId}_${replyId}`
      : `lead_reply_notif_${workspaceId}_${leadEmail.toLowerCase()}_${Date.now()}`
    const ins = await pool.query(
      `INSERT INTO portal_meta (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [dedupKey]
    )
    if (!ins.rows.length) return // this reply already notified (webhook retry)

    const tpl = await getTemplates()

    const clients = await pool.query(
      `SELECT c.email, c.contact_name, c.company_name
         FROM portal_clients c
        WHERE c.workspace_id = $1 AND c.active = true AND c.email IS NOT NULL AND c.email != ''`,
      [workspaceId]
    )
    const extra = await pool.query(
      `SELECT ua.identifier AS email, ua.display_name
         FROM portal_user_access ua
         JOIN portal_clients c ON c.id = ua.client_id
        WHERE c.workspace_id = $1 AND ua.identifier ILIKE '%@%'
          AND ua.notify = TRUE`,
      [workspaceId]
    )
    const allRecipients = [
      ...clients.rows.map((r: { email: string; contact_name: string | null; company_name: string | null }) => ({ email: r.email as string, name: firstName(r.contact_name, r.company_name) })),
      ...extra.rows.map((r: { email: string; display_name: string | null }) => ({ email: r.email as string, name: (r.display_name as string | null) || '' })),
    ]
    const seen = new Set<string>()
    for (const r of allRecipients) {
      if (seen.has(r.email.toLowerCase())) continue
      seen.add(r.email.toLowerCase())
      const name = r.name || 'there'
      const vars = { first_name: name, lead_name: leadName, lead_preview: preview.slice(0, 300), login_url: BASE_URL }
      const subject = render(tpl.lead_reply_subject, vars)
      const body = render(tpl.lead_reply_body, vars)
      await sendEmail(r.email, subject, body).catch(() => {})
    }
  } catch (err) {
    console.error('[email] notifyClientOfLeadReply failed:', err)
  }
}

// Trim a raw inbound email down to just the lead's message — strip quoted history
// and cap the length so the notification stays readable.
function cleanMessage(raw: string): string {
  if (!raw) return ''
  let t = raw.split(/\n\s*>?\s*On\b[\s\S]{0,200}?\bwrote:/)[0]
  t = t.split(/\n-{2,}\s*Original Message/i)[0]
  t = t.replace(/^\s*>.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  if (t.length > 600) t = t.slice(0, 600).trimEnd() + '…'
  return t
}

// What the lead actually wrote — newest inbound message. Reads the cache first,
// falls back to a live PlusVibe fetch. Best-effort; returns '' on any failure.
async function getLeadMessage(workspaceId: string, leadEmail: string | null): Promise<string> {
  if (!leadEmail) return ''
  try {
    const r = await pool.query(
      `SELECT body_text, content_preview FROM portal_emails
        WHERE workspace_id = $1 AND lower(lead_email) = lower($2) AND direction = 'IN'
        ORDER BY timestamp_created DESC NULLS LAST LIMIT 1`,
      [workspaceId, leadEmail]
    )
    let msg = (r.rows[0]?.body_text || r.rows[0]?.content_preview || '') as string
    if (!msg) {
      const { data } = await getEmails(workspaceId, { lead: leadEmail })
      const inbound = data.filter(m => m.direction === 'IN')
        .sort((a, b) => String(a.timestamp_created ?? '').localeCompare(String(b.timestamp_created ?? '')))
      const last = inbound[inbound.length - 1]
      msg = last?.body?.text || last?.content_preview || ''
    }
    return cleanMessage(msg)
  } catch { return '' }
}

// Build the rendered subject/body a given client+lead would receive (also used
// by the admin "send test" preview).
async function buildLeadEmail(client: { contact_name: string | null; company_name: string | null }, lead: { first_name: string | null; company_name: string | null }, balance: number, locked: boolean, leadMessage: string) {
  const tpl = await getTemplates()
  const vars = {
    first_name: firstName(client.contact_name, client.company_name),
    lead_name: [lead.first_name].filter(Boolean).join(' ') || 'a new contact',
    lead_company: lead.company_name ? ` (${lead.company_name})` : '',
    lead_message: leadMessage || '(log in to read the full message)',
    balance: String(Math.max(0, balance)),
    login_url: BASE_URL,
  }
  const subject = render(locked ? tpl.notif_locked_subject : tpl.notif_subject, vars)
  const body = render(locked ? tpl.notif_locked_body : tpl.notif_body, vars)
  return { subject, body }
}

// Notify a client of a new lead — exactly ONCE per (client, lead). The unique
// constraint + ON CONFLICT DO NOTHING makes this safe against webhook retries,
// the sync cron, and concurrent fires. Locked leads (out of credit) get the
// "top up to unlock" variant and reveal no contact details.
export async function notifyClientOfLead(workspaceId: string, leadId: string): Promise<{ sent: boolean; reason?: string }> {
  // One portal_client per workspace (usually). Notify each.
  const clients = await pool.query(
    `SELECT id, email, contact_name, company_name FROM portal_clients WHERE workspace_id = $1 AND active = true`,
    [workspaceId]
  )
  if (!clients.rows.length) return { sent: false, reason: 'no_client' }

  const lead = await pool.query(`SELECT first_name, company_name, email FROM esp_leads WHERE id = $1`, [leadId])
  if (!lead.rows.length) return { sent: false, reason: 'no_lead' }

  let anySent = false
  for (const c of clients.rows) {
    // Claim the (client, lead) slot atomically. First claim sends; a 'failed'
    // claim can be re-claimed with backoff up to 5 attempts. Sent/sending rows
    // are never re-claimed, so a lead can never produce two emails.
    const claim = await pool.query(
      `INSERT INTO portal_lead_notifications (client_id, lead_id, status, attempts, next_retry_at)
       VALUES ($1, $2, 'sending', 1, NOW() + interval '5 minutes')
       ON CONFLICT (client_id, lead_id) DO UPDATE
         SET status = 'sending',
             attempts = portal_lead_notifications.attempts + 1,
             next_retry_at = NOW() + (interval '5 minutes' * (portal_lead_notifications.attempts + 1))
       WHERE portal_lead_notifications.status = 'failed'
         AND portal_lead_notifications.attempts < 5
         AND portal_lead_notifications.next_retry_at <= NOW()
       RETURNING id`,
      [c.id, leadId]
    )
    if (!claim.rows.length) continue // already sent/sending, or retries exhausted
    if (!c.email) {
      await pool.query(`UPDATE portal_lead_notifications SET status = 'sent' WHERE client_id = $1 AND lead_id = $2`, [c.id, leadId]).catch(() => {})
      continue
    }

    await reconcileLeadCharges(c.id)
    const balance = await getBalance(c.id)
    const locked = (await getLockedLeadIds(c.id)).has(leadId)
    // Only include the lead's message on the normal (unlocked) email.
    const leadMessage = locked ? '' : await getLeadMessage(workspaceId, lead.rows[0].email)
    const { subject, body } = await buildLeadEmail(c, lead.rows[0], balance, locked, leadMessage)
    // Idempotency-Key means even an ambiguous failure (timeout after Resend
    // accepted) can be retried without a duplicate landing in the inbox.
    // BCC the agency on the client's copy so we keep a record of every lead
    // notification WITHOUT the client seeing it. Per-user copies below are NOT BCC'd
    // (would send N dupes to the monitoring inbox).
    const res = await sendEmail(c.email, subject, body, `lead/${c.id}/${leadId}`, LEAD_NOTIFY_BCC)
    if (res.ok) {
      anySent = true
      await pool.query(`UPDATE portal_lead_notifications SET status = 'sent', sent_at = NOW() WHERE client_id = $1 AND lead_id = $2`, [c.id, leadId]).catch(() => {})
    } else {
      await pool.query(`UPDATE portal_lead_notifications SET status = 'failed' WHERE client_id = $1 AND lead_id = $2`, [c.id, leadId]).catch(() => {})
    }
  }

  // Also email each per-user login that opted in (notify=true) for this
  // workspace. Deduped per (identifier, lead). Uses the first client's context
  // (balance/locked) since they share the workspace.
  const baseClient = clients.rows[0]
  if (baseClient) {
    const users = await pool.query(
      `SELECT DISTINCT lower(ua.identifier) AS email, ua.display_name
         FROM portal_user_access ua
         JOIN portal_clients c ON c.id = ua.client_id AND c.active = true
        WHERE c.workspace_id = $1 AND ua.notify = TRUE
          AND ua.identifier IS NOT NULL AND ua.identifier <> ''`,
      [workspaceId]
    )
    if (users.rows.length) {
      const balance = await getBalance(baseClient.id)
      const locked = (await getLockedLeadIds(baseClient.id)).has(leadId)
      const leadMessage = locked ? '' : await getLeadMessage(workspaceId, lead.rows[0].email)
      for (const u of users.rows) {
        // Don't double-send to an address already emailed as the client row.
        if (baseClient.email && u.email === String(baseClient.email).toLowerCase()) continue
        const claim = await pool.query(
          `INSERT INTO portal_user_lead_notifications (identifier, lead_id, workspace_id)
           VALUES ($1, $2, $3) ON CONFLICT (identifier, lead_id) DO NOTHING RETURNING identifier`,
          [u.email, leadId, workspaceId]
        )
        if (!claim.rows.length) continue // already sent to this user
        const recipient = { contact_name: u.display_name, company_name: baseClient.company_name }
        const { subject, body } = await buildLeadEmail(recipient, lead.rows[0], balance, locked, leadMessage)
        const res = await sendEmail(u.email, subject, body, `lead/u/${u.email}/${leadId}`)
        if (res.ok) anySent = true
        else await pool.query(`DELETE FROM portal_user_lead_notifications WHERE identifier = $1 AND lead_id = $2`, [u.email, leadId]).catch(() => {})
      }
    }
  }

  return { sent: anySent }
}

// Email a client that a new invoice is waiting. Best-effort.
export async function notifyClientOfInvoice(clientId: string, invoice: { description: string; amount: number; currency?: string }): Promise<void> {
  try {
    const c = await pool.query(`SELECT email, contact_name, company_name FROM portal_clients WHERE id = $1`, [clientId])
    const client = c.rows[0]
    if (!client?.email) return
    const tpl = await getTemplates()
    const cur = invoice.currency || 'GBP'
    const amount = new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur, minimumFractionDigits: 0 }).format(invoice.amount)
    const vars = {
      first_name: firstName(client.contact_name, client.company_name),
      description: invoice.description,
      amount,
      login_url: BASE_URL,
    }
    await sendEmail(client.email, render(tpl.invoice_subject, vars), render(tpl.invoice_body, vars))
  } catch (err) { console.error('[email] invoice notify failed:', err) }
}

// Send a notification to a client's email so admins can preview it. Uses the
// client's MOST RECENT real lead so the email is 100% identical to a live one.
export async function sendTestNotification(clientId: string): Promise<{ ok: boolean; reason?: string; to?: string }> {
  const c = await pool.query(`SELECT email, contact_name, company_name, workspace_id FROM portal_clients WHERE id = $1`, [clientId])
  if (!c.rows.length) return { ok: false, reason: 'no_client' }
  const client = c.rows[0]
  if (!client.email) return { ok: false, reason: 'no_email' }
  const balance = await getBalance(clientId)
  const locked = balance <= 0

  // Real latest lead → real name/company/message. Falls back to a generic example
  // only if this client has no leads yet.
  const leadRes = await pool.query(
    `SELECT id, first_name, company_name, email FROM esp_leads
      WHERE workspace_id = $1 AND source IN ('plusvibe', 'bison') AND label = 'INTERESTED'
      ORDER BY first_replied_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [client.workspace_id]
  )
  let lead: { first_name: string | null; company_name: string | null }
  let leadMessage: string
  if (leadRes.rows.length) {
    lead = leadRes.rows[0]
    leadMessage = locked ? '' : await getLeadMessage(client.workspace_id, leadRes.rows[0].email)
  } else {
    lead = { first_name: 'Sam', company_name: 'Acme Ltd' }
    leadMessage = locked ? '' : "Hi, thanks for reaching out — yes, this is something we're looking into. Could you send some availability for a quick call?"
  }

  const { subject, body } = await buildLeadEmail(client, lead, balance, locked, leadMessage)
  const res = await sendEmail(client.email, subject, body)
  return { ok: res.ok, reason: res.reason, to: client.email }
}
