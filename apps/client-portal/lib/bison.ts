// EmailBison API client (replaces lib/plusvibe.ts).
// Auth: Authorization: Bearer <token>
// Base URL: BISON_API_URL env (defaults to self-hosted instance)
// Workspace context: each API key belongs to one workspace — no workspace_id param needed.

const BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '')
const KEY = process.env.BISON_API_KEY || ''

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

// Fetch all leads with `interested` status (equivalent to PlusVibe INTERESTED label).
// Bison uses cursor-free pagination: page (1-based) + per_page.
export async function getLeads(page = 1, perPage = 100): Promise<BisonLead[]> {
  const data = await bison<{ data?: BisonLead[] }>('GET', '/api/leads', {
    'filters[lead_campaign_status]': 'replied',
    status: 'interested',
    page,
    per_page: perPage,
  })
  return Array.isArray(data) ? (data as unknown as BisonLead[]) : data.data ?? []
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
