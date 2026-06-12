// EmailBison API client (replaces lib/plusvibe.ts).
// Auth: Authorization: Bearer <token>
// Base URL: BISON_API_URL env (defaults to self-hosted instance)
// Workspace context: each API key belongs to one workspace — no workspace_id param needed.

const BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '')
const KEY = process.env.BISON_API_KEY || ''

// PlusVibe workspace_id → Bison team_id. portal_clients.workspace_id holds the
// PV id; Bison needs the team_id to switch workspace. Requires a SUPER-ADMIN
// BISON_API_KEY (one that can switch into every client team). Update when a
// client is added/migrated to Bison.
const PV_TO_BISON_TEAM: Record<string, string> = {
  '690ee665bcb253de4fb44538': '3',   // Ottaly
  '6912ddfef9582848982b9a62': '4',   // AccrueAccounting
  '69a9db307af7ef2854f57637': '5',   // ButterflyEco
  '6a0cc49a4a80688441614dfb': '12',  // MagnaMoney
  '69ffaf6904ca7138af16013a': '13',  // Bruud
  '69c43d1e07bf312ff0026643': '14',  // GXI-Furniture
  '69c43d1407bf312ff0026642': '15',  // GXI
  '695259c3d6154e27d164bcf7': '17',  // Indigo
  '699714b02f0830a7148fcf3e': '18',  // Enviro
  '695259dc8de377db7577dc45': '19',  // PPC
  '697e20f02db8460f8ba68792': '20',  // Jumping Spider (JSM)
  '69525a0eceae00718efdaeaa': '21',  // HydrationCompany
  '69a686632f5aaca7d9602c1f': '22',  // Animo
  '6a1d40b3bb80380c1be750c6': '23',  // ButterflyEco SOP
}
export function bisonTeamForWorkspace(workspaceId: string): string | null {
  return PV_TO_BISON_TEAM[workspaceId] ?? null
}

let _activeTeam: string | null = null
// Switch the (super-admin) token's active workspace. Stateful — serialize calls.
export async function switchWorkspace(teamId: string | number): Promise<void> {
  const id = String(teamId)
  if (_activeTeam === id) return
  await bison('POST', '/api/workspaces/v1.1/switch-workspace', undefined, { workspace_id: Number(teamId) })
  _activeTeam = id
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra }
}

async function bison<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (params && method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const init: RequestInit = {
    method,
    headers: headers(),
    signal: AbortSignal.timeout(15000),
  }
  if (body && method !== 'GET') init.body = JSON.stringify(body)

  const res = await fetch(url.toString(), init)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Bison ${method} ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface BisonWorkspace {
  id: number
  name: string
  personal_team: boolean
  main: boolean
}

export interface BisonLead {
  id: number
  first_name?: string | null
  last_name?: string | null
  email: string
  title?: string | null
  company?: string | null
  notes?: string | null
  status?: string | null
  custom_variables?: Array<{ name: string; value: string }>
  lead_campaign_data?: unknown[]
  created_at?: string
  updated_at?: string
}

export interface BisonReply {
  id: number
  uuid: string
  folder: string
  subject?: string | null
  read: boolean
  interested: boolean
  automated_reply: boolean
  html_body?: string | null
  text_body?: string | null
  date_received?: string | null
  campaign_id?: number | null
  lead_id?: number | null
  sender_email_id?: number | null
  raw_message_id?: string | null
  from_name?: string | null
  from_email_address?: string | null
  primary_to_email_address?: string | null
  to?: Array<{ name: string | null; address: string }>
  cc?: Array<{ name: string | null; address: string }> | null
  bcc?: Array<{ name: string | null; address: string }> | null
  parent_id?: number | null
  created_at?: string
  updated_at?: string
}

// ── Workspaces ────────────────────────────────────────────────────────────────

export async function getWorkspaces(): Promise<BisonWorkspace[]> {
  const data = await bison<{ data?: BisonWorkspace[] }>('GET', '/api/workspaces')
  return Array.isArray(data) ? (data as unknown as BisonWorkspace[]) : data.data ?? []
}

// ── Leads ────────────────────────────────────────────────────────────────────

// Resolve the CURRENT workspace's "lead" tag id (the marker used to flag a real
// lead). NOT cached globally — tag ids differ per workspace, and getLeads may
// switch workspace. Returns null if the tag doesn't exist.
async function getLeadTagId(): Promise<number | null> {
  try {
    const data = await bison<{ data?: Array<{ id: number; name: string }> }>('GET', '/api/tags')
    const list = Array.isArray(data) ? (data as unknown as Array<{ id: number; name: string }>) : data.data ?? []
    const tag = list.find(t => (t.name || '').toLowerCase() === 'lead')
    return tag ? tag.id : null
  } catch {
    return null
  }
}

// Fetch leads flagged as real leads for a given client workspace.
// - teamId (optional): the client's Bison team_id — switches workspace first so
//   a super-admin key can pull EACH client's leads (without it, a single-key
//   token only ever sees its own workspace → 0 leads for everyone else).
// - Marker: the "lead" TAG (the user's convention). Falls back to
//   status=interested if no "lead" tag exists, so behaviour never regresses.
// Bison uses cursor-free pagination: page (1-based) + per_page.
export async function getLeads(page = 1, perPage = 100, teamId?: string | number | null): Promise<BisonLead[]> {
  if (teamId != null && teamId !== '') {
    try {
      await switchWorkspace(teamId)
      if (page === 1) console.log(`[bison.getLeads] switched to team ${teamId}`)
    } catch (e) {
      console.warn(`[bison.getLeads] switch to team ${teamId} FAILED (key may not be super-admin):`, (e as Error).message)
    }
  }
  const leadTagId = await getLeadTagId()
  if (page === 1) console.log(`[bison.getLeads] team=${teamId ?? 'default'} leadTagId=${leadTagId ?? 'none(fallback status=interested)'}`)
  const params: Record<string, string | number | boolean | undefined> =
    leadTagId != null
      ? { 'filters[tag_ids][]': leadTagId, page, per_page: perPage }
      : { 'filters[lead_campaign_status]': 'replied', status: 'interested', page, per_page: perPage }
  const data = await bison<{ data?: BisonLead[] }>('GET', '/api/leads', params)
  const out = Array.isArray(data) ? (data as unknown as BisonLead[]) : data.data ?? []
  if (page === 1) console.log(`[bison.getLeads] team=${teamId ?? 'default'} page1 returned ${out.length} lead(s)`)
  return out
}

// Fetch a single lead by ID or email.
export async function getLead(idOrEmail: string | number): Promise<BisonLead | null> {
  try {
    const data = await bison<{ data?: BisonLead }>('GET', `/api/leads/${idOrEmail}`)
    return data.data ?? null
  } catch {
    return null
  }
}

// Fetch all replies for a specific lead (their email thread).
// Returns inbox + sent messages so callers can distinguish direction via `folder`.
export async function getLeadReplies(leadId: number | string): Promise<BisonReply[]> {
  const data = await bison<{ data?: BisonReply[] }>('GET', `/api/leads/${leadId}/replies`, {
    folder: 'all',
  })
  return Array.isArray(data) ? (data as unknown as BisonReply[]) : data.data ?? []
}

// ── Replies / sending ────────────────────────────────────────────────────────

// Reply to an existing message thread.
export async function sendReply(input: {
  replyId: number
  bodyText: string
  bodyHtml?: string
  senderEmailId?: number
  ccEmails?: string[]
  replyAll?: boolean
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    await bison('POST', `/api/replies/${input.replyId}/reply`, undefined, {
      message: input.bodyHtml ?? input.bodyText,
      content_type: input.bodyHtml ? 'html' : 'text',
      reply_all: input.replyAll ?? true,
      ...(input.senderEmailId ? { sender_email_id: input.senderEmailId } : {}),
      ...(input.ccEmails?.length
        ? { cc_emails: input.ccEmails.map(e => ({ email_address: e, name: null })) }
        : {}),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Lead status ───────────────────────────────────────────────────────────────

// Mark a lead as inactive (equivalent to PlusVibe NON_LEAD).
// Bison status enum: verified | unverified | unknown | risky | inactive
export async function updateLeadStatus(
  leadIdOrEmail: string | number,
  status: 'inactive' | 'verified' | 'unverified' | 'unknown' | 'risky',
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await bison('PATCH', `/api/leads/${leadIdOrEmail}/update-status`, undefined, { status })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

const WEBHOOK_TARGET =
  process.env.BISON_WEBHOOK_TARGET_URL ||
  process.env.PLUSVIBE_WEBHOOK_TARGET_URL ||
  'https://ottaly-git.oix3xv.easypanel.host/webhook/plusvibe-reply'

const WEBHOOK_EVENTS = ['lead_interested', 'lead_replied', 'untracked_reply_received']

interface BisonHook { id: number; name: string; url: string; events: string[] }

export async function registerWebhook(): Promise<{ ok: boolean; reason?: string }> {
  if (!KEY) return { ok: false, reason: 'no-api-key' }
  try {
    const list = await bison<{ data?: BisonHook[] }>('GET', '/api/webhook-url').catch(() => ({ data: [] as BisonHook[] }))
    const covered = (list.data ?? []).some(h =>
      h.url === WEBHOOK_TARGET ||
      h.url.includes('/webhook/bison') ||
      h.url.includes('/webhook/plusvibe') ||
      h.events.includes('lead_interested')
    )
    if (covered) return { ok: true, reason: 'already-exists' }

    await bison('POST', '/api/webhook-url', undefined, {
      name: 'Ottaly Portal',
      url: WEBHOOK_TARGET,
      events: WEBHOOK_EVENTS,
    })
    return { ok: true, reason: 'created' }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export const BISON_CONFIGURED = KEY.length > 0
