// Workspaces that skip the send rules (same-client cooldown + the three
// cross-client rules). Ottaly's own workspace sells Ottaly, not a client, so
// spacing it against client sends protects nothing. Jesse, 2026-09-28:
// "ottaly workspace should be allowed to email anyone, no blocks".
// DNC, departed and already-in-campaign checks still apply.
const GUARD_EXEMPT_WORKSPACES = new Set([
  '690ee665bcb253de4fb44538', // Ottaly
]);

function isGuardExemptWorkspace(workspaceId) {
  return GUARD_EXEMPT_WORKSPACES.has(String(workspaceId || ''));
}

module.exports = { GUARD_EXEMPT_WORKSPACES, isGuardExemptWorkspace };
