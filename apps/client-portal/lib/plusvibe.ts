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
