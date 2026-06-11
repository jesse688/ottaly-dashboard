// Compatibility shim — all functionality moved to lib/bison.ts.
// Re-export Bison equivalents under the old names so callers don't need updating yet.
export {
  getWorkspaces,
  getLeads as getLeadsRaw,
  getLeadReplies as getEmails,
  sendReply,
  updateLeadStatus,
  registerWebhook,
  BISON_CONFIGURED as PV_LABELS,
  type BisonWorkspace as PVWorkspace,
  type BisonLead as PVLead,
  type BisonReply as PVEmail,
} from './bison'

// Stub: PlusVibe workspace-scoped getLeads had (workspaceId, label, page, limit).
// Bison doesn't have per-workspace keys (one key = one workspace), so workspaceId is unused.
export async function getLeads(
  _workspaceId: string,
  _label: string,
  page = 1,
  limit = 100,
) {
  const { getLeads: bisonGetLeads } = await import('./bison')
  return bisonGetLeads(page, limit)
}
