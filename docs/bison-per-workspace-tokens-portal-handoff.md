# Handoff: per-workspace Bison tokens for the client portal (login.ottaly)

**Status:** admin.ottaly side is DONE (branch `feat/bison-per-workspace-tokens` → PR into `stable`). This doc is the matching change for the **client portal**, whose source is in a **separate repo** (not in ottaly-dashboard — `apps/client-portal/` here is just built `.next/` output).

## Why
Bison's API is stateful: `POST /api/workspaces/v1.1/switch-workspace {team_id}` changes the active workspace for the **whole token**, and Bison treats a token's active workspace as one logged-in session. Anything that switches a shared token kicks every other session on it ("only one login at a time"). Jesse gets logged out of the **Bison web UI** because his human login shares the cron's account/token.

The fix everywhere: **stop switching.** Give each workspace its own scoped token and never call `switch-workspace`.

## Decision (2026-06-15)
**Separate token per app.** The portal must mint its **OWN** per-workspace tokens — do **NOT** reuse admin's tokens and **NEVER** use admin's super-admin key in the portal. Rotating/revoking one app's token must not affect the other.

## The endpoint
`POST /api/workspaces/v1.1/{team_id}/api-tokens` with body `{ "name": "ottaly-portal-<client>" }`, authorized by a **super-admin** Bison key. Returns:
```json
{ "data": { "id": 39, "name": "...", "plain_text_token": "39|abc...", "abilities": ["*"], ... } }
```
`plain_text_token` is the per-workspace bearer. (Verified in bison-openapi-spec.yaml line 13231.)

## What to change in the portal repo
1. **Storage:** add `portal_settings` key `bison_ws_tokens` = `{ [team_id]: plain_text_token }` (mirrors admin's `app_settings.bison_ws_tokens`). Hydrate into a module map on boot; expose `getBisonWsToken(teamId)`.
2. **`lib/bison.ts` — `withTeam(teamId, fn)` / `getLeads` / `getLeadRepliesByEmail`:** before switching, look up `getBisonWsToken(teamId)`. If present, use it as the `Authorization: Bearer` for the request and **skip the `switch-workspace` call**. If absent, keep current behavior (switch the portal's super-admin key — which is the collision source, so aim for 100% coverage).
3. **Minting:** either reuse admin's mint output (NO — decision is separate tokens) or add a portal-side mint (super-admin key → loop the portal's client→team_id map → store). A one-off script is fine; the portal only has ~the mapped Bison clients.
4. **Settings UI:** optional — a "Mint per-workspace tokens" button in the portal admin settings, same shape as admin.ottaly's panel.

## Reference: how admin.ottaly did it (copy the shape)
In `apps/admin-legacy/server.js`:
- `_bisonWsTokens` map + `getBisonWsToken()` near `getBisonKey()`
- bearer-selection + skip-switch in both `_bisonRaw` and `bisonFetch`
- `GET/POST(mint)/DELETE /api/admin/bison-tokens`
- boot hydration of `bison_ws_tokens` alongside `bison_api_key`
- UI panel in `admin.html` (`loadBisonTokens`/`mintBisonTokens`/`clearBisonTokens`)

## Verify
After minting + deploy: log into the Bison web UI as Jesse's human account and confirm you stay logged in while the portal serves client traffic. Belt-and-braces: the human web login should ALSO be a different Bison user than any API key in either app.
