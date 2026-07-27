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
  // The RFC Message-ID of the exact inbound reply we're answering (stored at
  // ingest as unibox_replies.bison_reply_id = `pv_<message-id>`). This is how
  // PlusVibe's OWN reply UI targets a thread — by the message identity, not by
  // re-guessing the sender's address. When we have it, an EXACT match wins.
  messageId?: string | null,
): Promise<{ id: string; from: string; to: string } | null> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return null

  // Senders we accept as "this lead's thread": the lead address + any alternates.
  const accepted = new Set(
    [leadEmail, ...acceptFrom].map(a => (a || '').toLowerCase().trim()).filter(Boolean)
  )
  // Normalise the target message-id for comparison (PV returns it WITH angle
  // brackets, e.g. "<8E52…@naturaw.co.uk>"; strip them + case for a robust match).
  const norm = (m: string | null | undefined) => (m ?? '').replace(/[<>]/g, '').trim().toLowerCase()
  const wantMsgId = norm(messageId)

  type PVEmail = { id?: string; eaccount?: string; from_address_email?: string; message_id?: string }

  // Pages to walk before giving up. PV returns small pages, so this is a real
  // scan, not a peek — but it stays bounded so a genuine miss can't hang a reply.
  const MAX_PAGES = 12

  // One lookup by a given `lead` query value. CRITICAL: PlusVibe's `lead=` filter is
  // LOOSE — it returns the mailbox's recent received emails (newest-first) even when
  // none are from this lead. So we must scan the WHOLE page, not just data[0], and
  // pick the right email by identity:
  //   1) EXACT message-id match (PV-native — the thread we're actually answering), else
  //   2) the newest email whose from_address_email is one of our accepted senders.
  // This fixes the bug where data[0] was some OTHER lead's newer reply, which failed
  // the sender check and flipped a genuine reply to "SEND MANUALLY".
  const pick = (emails: PVEmail[]): { id: string; from: string; to: string } | null => {
    if (wantMsgId) {
      const exact = emails.find(e => e.id && norm(e.message_id) === wantMsgId)
      if (exact) return { id: exact.id!, from: exact.eaccount ?? '', to: exact.from_address_email ?? leadEmail }
    }
    const bySender = emails.find(e => e.id && accepted.has((e.from_address_email ?? '').toLowerCase()))
    if (bySender) return { id: bySender.id!, from: bySender.eaccount ?? '', to: bySender.from_address_email ?? leadEmail }
    return null
  }

  // VERIFIED AGAINST THE LIVE API (2026-07-27): PlusVibe's `lead=` query param is
  // NOT a filter — it is IGNORED. Asking for lead=hannah@systemhydraulics.net
  // returned the workspace's 4 newest received emails, none of them hers. So this
  // endpoint only ever answers "the newest emails in this workspace".
  //
  // That is the whole "SEND MANUALLY" bug: a reply resolves only while the lead's
  // email is still near the top of the workspace-wide feed. Once other leads reply
  // and push it down, resolution fails — permanently, for that thread. It looked
  // intermittent (~17%) but is fully deterministic per thread, which is why the
  // same lead failed 7 times in a row.
  //
  // So: walk the feed with the `page_trail` cursor instead of reading one page,
  // and stop as soon as we match. Bounded so a miss can't hang the request.
  // This runs inside the client's reply request, so the whole scan gets a hard
  // wall-clock budget. Without it a string of slow pages (8s timeout each, across
  // two folders) could leave the client staring at a spinner for minutes.
  const deadline = Date.now() + 12_000

  const scanFolder = async (path: string, extraParams: Record<string, string>) => {
    let pageTrail: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() > deadline) return null
      const url = new URL(`https://api.plusvibe.ai/api/v1/${path}`)
      url.searchParams.set('workspace_id', workspaceId)
      for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v)
      if (pageTrail) url.searchParams.set('page_trail', pageTrail)

      let data: { page_trail?: string; data?: PVEmail[] } | null = null
      // Retry each page ONCE on a transient failure (timeout / 5xx / network) — a
      // single slow PV call used to silently flip a genuine reply to manual.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          })
          if (!res.ok) throw new Error(`pv_${res.status}`)
          data = await res.json() as { page_trail?: string; data?: PVEmail[] }
          break
        } catch {
          if (attempt === 0) await new Promise(r => setTimeout(r, 600))
        }
      }
      if (!data) return null                       // both attempts failed — give up on this folder

      const batch = data.data ?? []
      if (!batch.length) return null
      const hit = pick(batch)
      if (hit) return hit

      // No new ids means the cursor isn't advancing (param ignored / end of feed).
      let added = 0
      for (const e of batch) if (e.id && !seen.has(e.id)) { seen.add(e.id); added++ }
      if (added === 0 || !data.page_trail) return null
      pageTrail = data.page_trail
    }
    return null
  }

  // The tracked feed first (where campaign replies live), then PV's "Others"
  // folder — a reply PV couldn't link to a campaign sequence never appears in
  // `received` at all, but we ingest and show it, so the client can reply to it.
  return (
    await scanFolder('unibox/emails', { email_type: 'received' })
    ?? await scanFolder('unibox/other-emails', {})
  )
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
//
// GUARANTEED LAST RESORT: pass an EMPTY `replyToId` and this posts to
// /unibox/emails/send instead, which needs only subject/from/to (+ body) — no
// thread id, no lead, no campaign. Verified against the live API: it accepts the
// same cc + attachments payload. The mail still goes FROM the client's own
// mailbox; it just isn't stitched onto the PV thread. That is strictly better
// than a human retyping it by hand, so an unresolvable thread no longer means a
// manual send.
export async function sendPlusVibeReply(opts: {
  workspaceId: string
  replyToId: string        // '' => send as a new email (no threading) instead
  subject: string
  from?: string
  to: string
  body: string
  cc?: string
  attachments?: { filename: string; content: Buffer }[]
}): Promise<{ ok: boolean; reason?: string }> {
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return { ok: false, reason: 'no_pv_key' }
  // /send has no thread to infer the sender from, so `from` is mandatory there.
  if (!opts.replyToId && !opts.from) return { ok: false, reason: 'no-sending-mailbox-resolved' }

  const payload = JSON.stringify({
    ...(opts.replyToId ? { reply_to_id: opts.replyToId } : {}),
    subject: opts.subject.startsWith('Re:') ? opts.subject : `Re: ${opts.subject}`,
    ...(opts.from ? { from: opts.from } : {}),
    to: opts.to,
    body: opts.body,
    ...(opts.cc ? { cc: opts.cc } : {}),
    ...(opts.attachments?.length
      ? { attachments: opts.attachments.map(a => ({ file_name: a.filename, content: a.content.toString('base64') })) }
      : {}),
  })

  // PlusVibe rate-limits sends with a 429 (and occasionally 5xx / gateway HTML
  // error pages). Those are transient — a client reply that hit one used to fall
  // straight to "SEND MANUALLY". Retry transient failures with backoff (honoring
  // Retry-After) before giving up. 4xx other than 429 (e.g. pv_400 "from is
  // required") are permanent, so fail fast — retrying can't fix them.
  const MAX_ATTEMPTS = 4
  const TRANSIENT = new Set([429, 500, 502, 503, 504])
  let lastReason = 'send_failed'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        `https://api.plusvibe.ai/api/v1/unibox/emails/${opts.replyToId ? 'reply' : 'send'}?workspace_id=${encodeURIComponent(opts.workspaceId)}`,
        {
          method: 'POST',
          headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(30000),
        }
      )
      if (res.ok) return { ok: true }

      const text = await res.text()
      lastReason = `pv_${res.status}: ${text.slice(0, 200)}`

      if (!TRANSIENT.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
        console.error('[sendPlusVibeReply] error:', res.status, text)
        return { ok: false, reason: lastReason }
      }
      // Transient — back off (Retry-After header if given, else exponential) then retry.
      const ra = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 800 * 2 ** attempt
      console.warn(`[sendPlusVibeReply] transient ${res.status}, retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`)
      await new Promise(r => setTimeout(r, waitMs))
    } catch (err) {
      // Network error / timeout — also transient. Retry unless we're out of attempts.
      lastReason = String(err)
      if (attempt === MAX_ATTEMPTS - 1) {
        console.error('[sendPlusVibeReply] failed:', err)
        return { ok: false, reason: lastReason }
      }
      const waitMs = 800 * 2 ** attempt
      console.warn(`[sendPlusVibeReply] network error, retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${waitMs}ms:`, lastReason)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return { ok: false, reason: lastReason }
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
