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
  // Other addresses the lead may have replied FROM (e.g. a colleague's mailbox).
  // Recorded at ingest; pass them so a colleague-address reply still resolves.
  acceptFrom: string[] = [],
): Promise<{ id: string; from: string; to: string } | null> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return null

  // Senders we accept as "this lead's thread": the lead address + any alternates.
  const accepted = new Set(
    [leadEmail, ...acceptFrom].map(a => (a || '').toLowerCase().trim()).filter(Boolean)
  )

  // One lookup by a given `lead` query value. SAFETY: PlusVibe ignores an
  // unmatched `lead` filter and returns the workspace's latest email instead, so
  // we accept the result ONLY if it's actually FROM one of our accepted senders.
  const tryLead = async (q: string): Promise<{ id: string; from: string; to: string } | null> => {
    const res = await fetch(
      `https://api.plusvibe.ai/api/v1/unibox/emails?workspace_id=${encodeURIComponent(workspaceId)}&lead=${encodeURIComponent(q)}&email_type=received`,
      { headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) throw new Error(`pv_${res.status}`)   // treat non-200 as retryable
    const data = await res.json() as {
      data?: { id?: string; eaccount?: string; from_address_email?: string }[]
    }
    const email = data?.data?.[0]
    if (!email?.id) return null
    if (!accepted.has((email.from_address_email ?? '').toLowerCase())) return null
    return { id: email.id, from: email.eaccount ?? '', to: email.from_address_email ?? q }
  }

  // Query by the lead address first, then each alternate. Retry each ONCE on a
  // transient failure (timeout / 5xx / network) — a single slow PV call is what
  // was silently flipping genuine replies to "send manually".
  for (const q of [leadEmail, ...acceptFrom]) {
    if (!q) continue
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const hit = await tryLead(q)
        if (hit) return hit
        break   // valid response, just not a match for this q — move to next q
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 600))  // brief backoff, then retry
      }
    }
  }
  return null
}

// A received email from the PlusVibe unibox.
export interface PVReceivedEmail {
  id: string
  lead_id?: string
  campaign_id?: string
  from_address_email?: string
  subject?: string
  content_preview?: string
  timestamp_created?: string
  eaccount?: string                 // the mailbox that received it (our sending account)
  to_address_email_list?: string
  label?: string                    // PV's own classification: INTERESTED / OUT_OF_OFFICE / AUTOMATIC_REPLY / ...
  lead?: string                     // the lead's email address
  message_id?: string
  // Full body (with signature). PV nests it under body.{html,text}; some payloads
  // use html_body/text_body. Needed to seed the client-facing thread.
  body?: { html?: string; text?: string } | null
  html_body?: string | null
  text_body?: string | null
}

// Live list of ALL PlusVibe workspaces (id + name) for this API key. Used to
// populate the admin "add client" picker from the SOURCE OF TRUTH, so a client
// is always attached to a real workspace by name — never a free-typed id (that's
// how an API key once got pasted into the workspace field).
export async function getPlusVibeWorkspaces(): Promise<{ id: string; name: string }[]> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return []
  try {
    const res = await fetch('https://api.plusvibe.ai/api/v1/workspaces', {
      headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const json = await res.json() as unknown
    const arr = Array.isArray(json) ? json : ((json as { data?: unknown[] }).data ?? [])
    return (arr as { id?: string; name?: string }[])
      .filter(w => !!w.id)
      .map(w => ({ id: w.id as string, name: (w.name || w.id) as string }))
  } catch {
    return []
  }
}

// Page the PlusVibe unibox emails for a whole workspace (newest-first).
// THIS is where replies live — Bison/EmailBison is retired and returns nothing.
// Stops when a page is older than sinceMs, when there are no new ids (param
// ignored / end), or at the page cap. Paginates via the `page_trail` cursor.
//
// `emailType` selects the FOLDER:
//   'received'  — campaign-tracked replies (the main feed).
//   'untracked' — PlusVibe's "Others" folder: replies that arrived on a
//                 connected mailbox but PV couldn't link to a campaign sequence
//                 (e.g. a follow-up whose threading headers didn't match). These
//                 are missed by the 'received' feed entirely, yet they're real
//                 lead replies — so we ingest them too. (This is the bug where a
//                 lead's 2nd message lands in Others and never reaches the client
//                 dashboard.)
export async function getPlusVibeReceived(
  workspaceId: string,
  opts: { sinceMs?: number; maxPages?: number; emailType?: 'received' | 'untracked' } = {},
): Promise<PVReceivedEmail[]> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return []
  const maxPages = opts.maxPages ?? 30
  const emailType = opts.emailType ?? 'received'
  const out: PVReceivedEmail[] = []
  const seen = new Set<string>()
  let pageTrail: string | undefined
  for (let p = 0; p < maxPages; p++) {
    // The "Others" folder (replies PV couldn't link to a campaign/lead) is a
    // DEDICATED PlusVibe endpoint — /unibox/other-emails — NOT email_type=untracked
    // (that was a Bison concept and returns nothing on PV). The tracked feed is
    // /unibox/emails?email_type=received.
    const url = emailType === 'untracked'
      ? new URL('https://api.plusvibe.ai/api/v1/unibox/other-emails')
      : new URL('https://api.plusvibe.ai/api/v1/unibox/emails')
    url.searchParams.set('workspace_id', workspaceId)
    if (emailType !== 'untracked') url.searchParams.set('email_type', emailType)
    if (pageTrail) url.searchParams.set('page_trail', pageTrail)
    let res: Response
    try {
      res = await fetch(url, { headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
    } catch { break }
    if (!res.ok) break
    const data = await res.json() as { page_trail?: string; data?: PVReceivedEmail[] }
    const batch = data.data ?? []
    if (!batch.length) break
    // Add only new ids; if a page brings nothing new, the cursor isn't advancing — stop.
    let added = 0
    for (const e of batch) {
      if (e.id && !seen.has(e.id)) { seen.add(e.id); out.push(e); added++ }
    }
    if (added === 0) break
    if (opts.sinceMs != null) {
      const oldest = batch.reduce((min, e) => {
        const t = e.timestamp_created ? Date.parse(e.timestamp_created) : NaN
        return Number.isNaN(t) ? min : Math.min(min, t)
      }, Infinity)
      if (oldest !== Infinity && oldest < opts.sinceMs) break
    }
    if (!data.page_trail) break
    pageTrail = data.page_trail
  }
  return out
}

// Reply to a PlusVibe unibox email. POST /unibox/emails/reply?workspace_id=...
// `from` is optional — if omitted PlusVibe infers the sender from the reply_to_id.
// Attachments are supported natively: PV takes an array of { file_name, content }
// where content is base64 — so a client reply WITH a file still sends from the
// client's own mailbox (no Resend, no Ottaly-identity leak).
export async function sendPlusVibeReply(opts: {
  workspaceId: string
  replyToId: string
  subject: string
  from?: string
  to: string
  body: string
  cc?: string
  attachments?: { filename: string; content: Buffer }[]
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
          ...(opts.attachments?.length
            ? { attachments: opts.attachments.map(a => ({ file_name: a.filename, content: a.content.toString('base64') })) }
            : {}),
        }),
        signal: AbortSignal.timeout(30000),
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
