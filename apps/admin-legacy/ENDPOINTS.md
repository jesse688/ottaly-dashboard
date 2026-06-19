# Ottaly Admin (admin-legacy) — Endpoint & API Reference

Single source of truth for **what APIs this app calls out to** and **how it talks to
PlusVibe**. Keep this updated when you add/remove/change an endpoint or a PlusVibe call.

> Regenerate the inbound-route list any time with:
> `node scripts/list-endpoints.js`  (writes the table in §3 below)

Last reviewed: 2026-06-19 (post Bison→PlusVibe migration — Bison account deactivated)

---

## 1. Outbound third-party APIs

| Service | Base URL | Auth | Notes |
|---|---|---|---|
| **PlusVibe** | `https://api.plusvibe.ai/api/v1` | `x-api-key: <key>` | Key from admin dashboard (app_settings `pv_api_key`) → falls back to `PLUSVIBE_KEY` env. Read live via `getPvKey()`. **STATELESS** — workspace_id is a query param, no session switch. Needs `User-Agent` header (Cloudflare). See §2. |
| Anthropic | api.anthropic.com | `x-api-key: ANTHROPIC_API_KEY` | LLM calls (briefings, enrichment). Not ESP. |
| Companies House | api.company-information.service.gov.uk | Basic | Company/officer lookups. |
| Reacher / SMTP verify | internal | — | Email verification. |
| ~~EmailBison~~ | ~~send.ottaly.co.uk~~ | ~~Bearer~~ | **RETIRED 2026-06-19.** Account deactivated. All calls migrated back to PlusVibe. Bison helpers are stubs. Do not reintroduce. |

---

## 2. PlusVibe — how we call it

**Stateless workspace model:** PlusVibe takes `workspace_id` as a query param on every
call — no switch-workspace, no per-workspace tokens, no mutex. Concurrent calls are safe
(rate-limited to ~1 req / 600ms via a shared gap in `pvApi`).

**Helpers (all in server.js, module-scope):**
- `pvApi(path, {method, body, wsId, params})` — primary client. Adds `workspace_id`,
  `x-api-key`, `User-Agent`. Retries on 429 with backoff. Returns parsed JSON (null on 204).
- `pvListAllAccounts(wsId, {skip, limit})` — paginate `/account/list` (limit/skip) → flat array.
- `pvWorkspaceLeads(wsId, {label, page, perPage})` — `/lead/workspace-leads` → plain leads array.
- `listPvWorkspaces()` — returns `{workspaces:[{id,name}]}` from the static `PV_WORKSPACES` map.
- `getPvKey()` — current key (dashboard override `pv_api_key` or `PLUSVIBE_KEY` env).
- `PV_WORKSPACES` — `{pv, name}` per client (PV workspace_id). `BISON_TEAMS` is a back-compat
  alias mapping `{team_id: pv, pv, name}` for a few admin endpoints; both key off the PV id.
- Bison shims (`bisonReq`, `bisonFetch`, `bisonSwitch`, `getBisonKey`, `listBisonWorkspaces`,
  `resolveBisonTeamId`, `bisonListSenderEmails`, etc.) remain as thin redirects to the PV
  helpers (or safe no-ops) so leftover diagnostic call-sites don't ReferenceError.

**PlusVibe endpoints we use:**

| PlusVibe endpoint | Used for | Helper sites |
|---|---|---|
| `GET /account/email-stats` | Daily sent/reply/bounce chart (per-date rows) | stats, perfshim email-stats, combo-analysis |
| `GET /account/list` | **List mailboxes** (`limit`+`skip`) | listSendingMailboxes, warmup, perfshim, mailbox-debug |
| `PATCH /account/bulk-update-warmup` | Enable/disable warmup | warmup enable/disable, pv-shutdown |
| `PATCH /account/bulk-update` | Set daily_limit (e.g. zero out sending) | pv-shutdown |
| `GET /campaign/list` | List campaigns | campaign cache, pv/campaigns, perfshim |
| `POST /campaign/create` | Create campaign | bison/create-campaign |
| `GET /lead/workspace-leads` | List/filter leads by label | pvWorkspaceLeads (perf, push, debug) |
| `POST /lead/add` | Create a lead (top-level native fields) | all push-contacts paths, ch-push |
| `POST /blocklist/add` | Suppress a bounced email | blocklistEmailEverywhere |

**Lead payload format (CRITICAL):** PlusVibe native fields (`first_name`, `last_name`,
`email`, `job_title`, `company_name`, `industry`, `city`, `linkedin_person_url`, etc.) must be
**top-level** on the lead object — NOT in a `custom_variables` array — or merge tags fail.

**Webhooks:** configured in the PlusVibe UI (no API registration). PV reply events arrive at
`/webhook/plusvibe-reply`; PV sends `event` as a string (Bison sent it as an object).

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
