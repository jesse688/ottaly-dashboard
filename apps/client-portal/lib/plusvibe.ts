// Compatibility shim — re-exports Bison API under old PlusVibe names.
// All outbound calls now route through EmailBison (send.ottaly.co.uk).

import {
  getWorkspaces as bisonGetWorkspaces,
  getLeads as bisonGetLeads,
  sendReply as bisonSendReply,
  updateLeadStatus as bisonUpdateLeadStatus,
  registerWebhook as bisonRegisterWebhook,
  BISON_CONFIGURED,
} from './bison'
export type { BisonWorkspace as PVWorkspace } from './bison'

export { getWorkspaces } from './bison'
export const PV_LABELS = BISON_CONFIGURED

export type PVLead = {
  _id: string; email: string; first_name?: string; last_name?: string
  company_name?: string; status?: string; campaign_id?: string; created_at?: string
  [k: string]: unknown
}
export type PVEmail = {
  id: string; direction: 'IN' | 'OUT'; subject?: string; timestamp_created?: string
  content_preview?: string; from_address_email?: string; to_address_email_list?: string
  body?: { html?: string; text?: string }; [k: string]: unknown
}

export async function getLeads(_workspaceId: string, _label: string, page = 1, limit = 100): Promise<PVLead[]> {
  const leads = await bisonGetLeads(page, limit)
  return leads.map(l => ({
    _id: String(l.id), email: l.email,
    first_name: l.first_name ?? undefined,
    last_name: l.last_name ?? undefined,
    company_name: l.company ?? undefined,
    status: l.status ?? undefined,
    created_at: l.created_at,
  }))
}

export async function getEmails(_workspaceId: string, _opts: { lead?: string } = {}): Promise<{ pageTrail: string; data: PVEmail[] }> {
  // Bison doesn't expose a workspace-wide email list; return empty so callers
  // fall back to the portal_emails DB cache, which webhook events keep current.
  return { pageTrail: '', data: [] }
}

export async function sendReply(_input: {
  workspaceId: string; leadEmail: string; eaccount?: string; subject?: string
  bodyText: string; bodyHtml?: string; cc?: string; replyToMessageId?: string
}): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: 'use-bison-direct' }
}

// Look up the real PlusVibe inbound email for a lead via the unibox API.
// Our DB stores `unibox_<id>` (from the Bison webhook) but PlusVibe's reply API
// wants the bare id. `eaccount` is the sending mailbox (reply FROM);
// `from_address_email` is the lead (reply TO).
export async function getPlusVibeInbound(
  workspaceId: string,
  leadEmail: string,
): Promise<{ id: string; from: string; to: string } | null> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.plusvibe.ai/api/v1/unibox/emails?workspace_id=${encodeURIComponent(workspaceId)}&lead=${encodeURIComponent(leadEmail)}&email_type=received`,
      { headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data = await res.json() as {
      data?: { id?: string; eaccount?: string; from_address_email?: string }[]
    }
    const email = data?.data?.[0]
    if (!email?.id) return null
    // SAFETY: PlusVibe ignores an unmatched `lead` filter and returns the
    // workspace's latest email instead. If the returned email isn't actually
    // FROM the lead we asked about, it's the wrong thread — refuse it.
    if ((email.from_address_email ?? '').toLowerCase() !== leadEmail.toLowerCase()) return null
    return { id: email.id, from: email.eaccount ?? '', to: email.from_address_email ?? leadEmail }
  } catch {
    return null
  }
}

// Reply to a PlusVibe unibox email. POST /unibox/emails/reply?workspace_id=...
// `from` is optional — if omitted PlusVibe infers the sender from the reply_to_id.
export async function sendPlusVibeReply(opts: {
  workspaceId: string
  replyToId: string
  subject: string
  from?: string
  to: string
  body: string
  cc?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return { ok: false, reason: 'no_pv_key' }
  try {
    const res = await fetch(
      `https://api.plusvibe.ai/api/v1/unibox/emails/reply?workspace_id=${encodeURIComponent(opts.workspaceId)}`,
      {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply_to_id: opts.replyToId,
          subject: opts.subject.startsWith('Re:') ? opts.subject : `Re: ${opts.subject}`,
          ...(opts.from ? { from: opts.from } : {}),
          to: opts.to,
          body: opts.body,
          ...(opts.cc ? { cc: opts.cc } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      }
    )
    if (!res.ok) {
      const text = await res.text()
      console.error('[sendPlusVibeReply] error:', res.status, text)
      return { ok: false, reason: `pv_${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    console.error('[sendPlusVibeReply] failed:', err)
    return { ok: false, reason: String(err) }
  }
}

export async function registerWebhook(_workspaceId?: string): Promise<{ ok: boolean; reason?: string }> {
  return bisonRegisterWebhook()
}

export async function updateLeadStatus(
  _workspaceId: string,
  leadEmail: string,
  status: string
): Promise<{ ok: boolean; reason?: string }> {
  const bisonStatus = (status.toUpperCase() === 'NON_LEAD' ? 'inactive' : status.toLowerCase()) as 'inactive'
  return bisonUpdateLeadStatus(leadEmail, bisonStatus)
}
