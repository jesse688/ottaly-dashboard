// Typed PlusVibe API client.
// Base + auth confirmed by probing the live API:
//   GET  /workspaces                        -> [{ id, name }]
//   GET  /lead/workspace-leads              -> [ lead ]   (workspace_id, label, page, limit)
//   GET  /campaign/list                     -> [ campaign ] (workspace_id, limit, skip)
//   GET  /unibox/emails                     -> { page_trail, data: [ message ] }
//                                              params: workspace_id, lead(email), label, campaign_id, page_trail
// Auth header is `x-api-key` (NOT Bearer).

const BASE = process.env.PLUSVIBE_API_URL || 'https://api.plusvibe.ai/api/v1'
const KEY = process.env.PLUSVIBE_API_KEY || process.env.PLUSVIBE_KEY || ''

function headers() {
  return { 'x-api-key': KEY }
}

async function pv<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), { headers: headers() })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`PlusVibe ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export interface PVWorkspace { id: string; name: string }

export interface PVLead {
  _id: string
  campaign_id?: string
  workspace_id?: string
  status?: string
  label?: string
  camp_name?: string
  email: string
  first_name?: string
  last_name?: string
  address_line?: string
  city?: string
  state?: string
  country?: string
  country_code?: string
  phone_number?: string
  job_title?: string
  department?: string
  company_name?: string
  company_website?: string
  industry?: string
  linkedin_person_url?: string
  linkedin_company_url?: string
  created_at?: string
  modified_at?: string
  [k: string]: unknown
}

export interface PVEmail {
  id: string
  direction: 'IN' | 'OUT'
  message_id?: string
  is_unread?: number
  lead_id?: string
  campaign_id?: string
  from_address_email?: string
  subject?: string
  timestamp_created?: string
  content_preview?: string
  thread_id?: string
  eaccount?: string
  to_address_email_list?: string
  label?: string
  lead?: string // lead email
  body?: { html?: string; text?: string }
  [k: string]: unknown
}

export async function getWorkspaces(): Promise<PVWorkspace[]> {
  const data = await pv<PVWorkspace[] | { workspaces?: PVWorkspace[] }>('/workspaces')
  return Array.isArray(data) ? data : data.workspaces ?? []
}

// Fetch leads for a workspace + label, one page at a time (page is 1-based).
export async function getLeads(workspaceId: string, label: string, page = 1, limit = 100): Promise<PVLead[]> {
  const data = await pv<PVLead[] | { data?: PVLead[]; leads?: PVLead[] }>('/lead/workspace-leads', {
    workspace_id: workspaceId, label, page, limit,
  })
  return Array.isArray(data) ? data : data.data ?? data.leads ?? []
}

// Fetch one page of unibox emails. Pass `lead` (email) to scope to a single lead's
// conversation, or page through the whole workspace with `page_trail` (cursor).
export async function getEmails(
  workspaceId: string,
  opts: { lead?: string; label?: string; campaignId?: string; pageTrail?: string } = {}
): Promise<{ pageTrail: string; data: PVEmail[] }> {
  const data = await pv<{ page_trail?: string; data?: PVEmail[] }>('/unibox/emails', {
    workspace_id: workspaceId,
    lead: opts.lead,
    label: opts.label,
    campaign_id: opts.campaignId,
    page_trail: opts.pageTrail,
  })
  return { pageTrail: data.page_trail ?? '', data: data.data ?? [] }
}

// Live reply send. The public v1 API does not expose a confirmed reply endpoint
// (only the internal MCP/app path does). This is isolated so the rest of the app
// doesn't care HOW a reply is sent. If PLUSVIBE_REPLY_URL is configured we POST to
// it; otherwise we report not-sent and the caller falls back to notifying the team.
export async function sendReply(input: {
  workspaceId: string
  leadEmail: string
  eaccount?: string
  subject?: string
  bodyText: string
  bodyHtml?: string
  cc?: string
  replyToMessageId?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const replyUrl = process.env.PLUSVIBE_REPLY_URL
  if (!replyUrl) return { ok: false, reason: 'no-reply-endpoint-configured' }
  try {
    const res = await fetch(replyUrl, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: input.workspaceId,
        lead: input.leadEmail,
        eaccount: input.eaccount,
        subject: input.subject,
        cc: input.cc,
        body: { text: input.bodyText, html: input.bodyHtml ?? `<p>${input.bodyText.replace(/\n/g, '<br/>')}</p>` },
        reply_to_message_id: input.replyToMessageId,
      }),
    })
    if (!res.ok) return { ok: false, reason: `send-failed-${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// Where PlusVibe should send lead/reply events. Defaults to the existing
// admin-legacy handler (which already syncs to esp_leads + portal_emails).
const WEBHOOK_TARGET =
  process.env.PLUSVIBE_WEBHOOK_TARGET_URL ||
  'https://ottaly-git.oix3xv.easypanel.host/webhook/plusvibe-reply'

// The "marked as lead" event is label-dependent — PlusVibe only knows it once a
// workspace has actually used the "Lead" label. So for a brand-new workspace we
// register the label-independent reply event now (always works), let the polling
// cron catch the first lead, then auto-upgrade the hook to include the lead event
// once it becomes available.
const WEBHOOK_EVENT_SETS = [
  ['LEAD_MARKED_AS_LEAD', 'ALL_EMAIL_REPLIES'],
  ['LEAD_MARKED_AS_LEAD'],
  ['ALL_EMAIL_REPLIES'],
]

interface PVHook { _id: string; url: string; name?: string; status?: string; evt_types?: string[] }
const hasLeadEvent = (h: PVHook) => (h.evt_types ?? []).includes('LEAD_MARKED_AS_LEAD')

async function addHook(workspaceId: string, events: string[]): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${BASE}/hook/add`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace_id: workspaceId, name: 'Ottaly Portal', url: WEBHOOK_TARGET,
      camp_ids: ['ALL'], event_types: events, is_slack: 0, secret: '', ignore_ooo: 1, ignore_automatic: 1,
    }),
  })
  return { ok: res.ok, status: res.status, body: (await res.text().catch(() => '')).slice(0, 160) }
}

async function delHook(workspaceId: string, id: string): Promise<void> {
  await fetch(`${BASE}/hook/del`, {
    method: 'DELETE', headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, ids: [id] }),
  }).catch(() => {})
}

// Ensure a lead/reply webhook exists for a workspace, pointing at our handler.
// - Skips if any hook already includes the lead event (e.g. existing Database1.0).
// - Upgrades our own reply-only hook to include the lead event once available.
// - Falls back through event sets so it always lands something.
export async function registerWebhook(workspaceId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!KEY) return { ok: false, reason: 'no-api-key' }
  try {
    const list = await pv<{ hooks?: PVHook[] }>('/hook/list', { workspace_id: workspaceId }).catch(() => ({ hooks: [] as PVHook[] }))
    const hooks = list.hooks ?? []

    // Already covered by ANY hook that includes the lead event? Done.
    if (hooks.some(hasLeadEvent)) return { ok: true, reason: 'already-exists' }

    // Our own reply-only hook exists (created earlier on an empty workspace) —
    // delete it so we can re-add now that the lead event may have become available.
    const ourReplyOnly = hooks.find(h => h.name === 'Ottaly Portal' && h.url === WEBHOOK_TARGET && !hasLeadEvent(h))
    if (ourReplyOnly) await delHook(workspaceId, ourReplyOnly._id)

    let last = { ok: false, status: 0, body: '' }
    for (const events of WEBHOOK_EVENT_SETS) {
      const r = await addHook(workspaceId, events)
      if (r.ok) return { ok: true, reason: events.includes('LEAD_MARKED_AS_LEAD') ? 'created' : 'created-replies-only' }
      if (/already exist/i.test(r.body)) return { ok: true, reason: 'already-exists' }
      last = r
    }
    return { ok: false, reason: `create-failed-${last.status}: ${last.body}` }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export const PV_LABELS = KEY ? true : false // truthy guard helper for callers
