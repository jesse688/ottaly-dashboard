# Ottaly Admin (admin-legacy) — Endpoint & API Reference

Single source of truth for **what APIs this app calls out to** and **how it talks to
EmailBison**. Keep this updated when you add/remove/change an endpoint or a Bison call.

> Regenerate the inbound-route list any time with:
> `node scripts/list-endpoints.js`  (writes the table in §3 below)

Last reviewed: 2026-06-14 (post PlusVibe→Bison migration)

---

## 1. Outbound third-party APIs

| Service | Base URL | Auth | Notes |
|---|---|---|---|
| **EmailBison** | `BISON_API_URL` (default `https://send.ottaly.co.uk`) | `Authorization: Bearer <key>` | Key from admin dashboard (app_settings `bison_api_key`) → falls back to `BISON_API_KEY` env. Read live via `getBisonKey()`. **STATEFUL** — see §2. |
| Anthropic | api.anthropic.com | `x-api-key: ANTHROPIC_API_KEY` | LLM calls (briefings, enrichment). Not ESP. |
| Companies House | api.company-information.service.gov.uk | Basic | Company/officer lookups. |
| Reacher / SMTP verify | internal | — | Email verification. |
| ~~PlusVibe~~ | ~~api.plusvibe.ai~~ | ~~x-api-key~~ | **RETIRED.** Key deprecated. All calls migrated to Bison. Do not reintroduce. |

---

## 2. EmailBison — how we call it

**Stateful workspace model:** Bison ties the active workspace to the token/session.
`POST /api/workspaces/v1.1/switch-workspace {team_id}` changes it for the whole token.
Calling concurrently from multiple places trips Bison's "only one login at a time".

**Helpers (all in server.js, module-scope):**
- `bisonReq(path, {wsId, params, method, body})` — primary client. Serialized via
  `_bisonGate` mutex so switch+fetch is atomic. Returns parsed JSON, throws on non-2xx.
- `bisonFetch(path, {wsId, params, method, body})` — older equivalent, same gate.
- `bisonSwitch(wsId)` — standalone switch (rarely needed; prefer passing `wsId` to the above).
- `bisonWorkspaceLeads(wsId, {label, page, perPage})` — replaces PV `/lead/workspace-leads`.
  Maps PV `label` → Bison `filters[lead_campaign_status]`, returns a plain leads array.
- `getBisonKey()` — current key (dashboard override or env).
- `BISON_TEAMS` — PV workspace_id ↔ Bison team_id map (frontend/clients table key by PV id;
  Bison keys by numeric team_id — always map at the boundary).

**Bison endpoints we use:**

| Bison endpoint | Used for | Helper sites |
|---|---|---|
| `GET /api/workspaces/v1.1` | List all workspaces | mailbox list, admin/pv workspaces, perfshim, webhook reg |
| `POST /api/workspaces/v1.1/switch-workspace` | Activate a workspace | inside bisonReq/bisonFetch when `wsId` given |
| `GET /api/workspaces/v1.1/line-area-chart-stats` | Daily sent/reply/bounce stats | stats, perfshim email-stats, combo-analysis |
| `GET /api/sender-emails` | **List mailboxes** (paginated `page`+`per_page`) | listSendingMailboxes, warmup cron, perfshim account-list, mailbox-debug |
| `GET /api/campaigns` | List campaigns | campaign cache, pv/campaigns, perfshim, copy |
| `POST /api/campaigns/{id}/leads/attach-leads` | Add leads to campaign | push-to-bison paths |
| `GET /api/leads` | List/filter leads | bisonWorkspaceLeads (audience seed, backfill, debug) |
| `POST /api/leads/create-or-update/multiple` | Create/update leads | all push-contacts paths |
| `POST /api/custom-variables` | Ensure custom vars exist | push paths |
| `PATCH /api/warmup/sender-emails/enable` | Enable warmup | mailboxes enable-warmup |
| `POST /api/replies/{id}/reply` | Send a reply | portal/inbox reply |
| `GET /api/replies/{id}/conversation-thread` | Thread messages | lead thread view |
| `GET|POST /api/webhook-url` | Register reply webhooks | startup webhook auto-register |

**Migration notes (PV → Bison equivalents):**
- PV `/workspaces` → `/api/workspaces/v1.1` (pvFetch('/workspaces') auto-redirects).
- PV `/account/list`, `/email-account/list` → `/api/sender-emails`.
- PV `/campaign/list` → `/api/campaigns`.
- PV `/lead/workspace-leads` → `/api/leads` (via `bisonWorkspaceLeads`).
- PV `/account/bulk-update-warmup` → `/api/warmup/sender-emails/enable`.

---

## 3. Inbound routes (this app's own API)

Run `node scripts/list-endpoints.js` to regenerate. High-level groups:

- `/api/admin/*` — admin-only (requireAdmin): clients, managers, bison-key, fresh-start,
  workspaces, mailbox-debug, page-visibility, payslips, enrich, migrations.
- `/api/mailboxes*` — mailbox dashboard (list, refresh, enable-warmup, bulk-tag/billing).
- `/api/stats*`, `/api/performance/*`, `/api/combo-analysis*` — stats/performance (date-ranged;
  respect the fresh-start clamp via `clampStartDate`).
- `/api/perfshim/*` — Bison-backed compatibility shim for performance.html / actions.html
  (emulates the old PV response shapes; sourced from Bison).
- `/api/pv/*` — legacy-named proxies, **now Bison-backed** (workspaces, campaigns, push-contacts,
  workspace-leads). Names kept for frontend compatibility; rename later if desired.
- `/api/bison/*` — explicit Bison push routes.
- `/api/clients/*`, `/api/leads/*`, `/api/audience/*`, `/api/copy/*`, `/api/domains/*` — feature APIs.
- `/api/stripe/*`, `/webhook/*` — billing + inbound webhooks.

---

## 4. Diagnostics

- `GET /api/admin/mailbox-debug` — live per-workspace mailbox count from Bison (find where
  the dashboard count diverges from Bison's real total).
- `POST /api/admin/bison-key/test` — verifies the key, returns workspace count.
- `[mailboxes] <client>: N` + `[mailboxes] total N across M workspaces` — boot/refresh logs.

---

## 5. Maintenance checklist

When adding/removing an endpoint:
1. Add/remove the `app.<method>('/api/...')` in server.js.
2. If it calls Bison, use a helper from §2 (never raw `fetch` to PV paths).
3. Update §2/§3 here and re-run `node scripts/list-endpoints.js`.
4. If it's date-ranged stats, apply `clampStartDate` to the start param.
5. `node --check server.js` before pushing.
