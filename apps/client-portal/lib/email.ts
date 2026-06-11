import pool from './db'
import { getBalance, getLockedLeadIds, reconcileLeadCharges } from './balance'
import { getEmails } from './plusvibe'

const FROM = process.env.EMAIL_FROM || 'Ottaly <info@ottaly.co.uk>'
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

// Low-level send via Resend. No-ops (logs) if RESEND_API_KEY isn't configured.
export async function sendEmail(to: string, subject: string, text: string, idempotencyKey?: string): Promise<{ ok: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping send'); return { ok: false, reason: 'no_api_key' } }
  if (!to) return { ok: false, reason: 'no_recipient' }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: FROM, to, subject, html: text.replace(/\n/g, '<br>') }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { const body = await res.text(); console.error('[email] resend error:', res.status, body); return { ok: false, reason: `resend_${res.status}` } }
    return { ok: true }
  } catch (err) {
    console.error('[email] send failed:', err)
    return { ok: false, reason: 'exception' }
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
    const res = await sendEmail(c.email, subject, body, `lead/${c.id}/${leadId}`)
    if (res.ok) {
      anySent = true
      await pool.query(`UPDATE portal_lead_notifications SET status = 'sent', sent_at = NOW() WHERE client_id = $1 AND lead_id = $2`, [c.id, leadId]).catch(() => {})
    } else {
      await pool.query(`UPDATE portal_lead_notifications SET status = 'failed' WHERE client_id = $1 AND lead_id = $2`, [c.id, leadId]).catch(() => {})
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
