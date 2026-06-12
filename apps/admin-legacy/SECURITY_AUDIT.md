# Security Audit — admin-legacy

> **Advisory only.** This report was generated for review. Nothing here has been changed in code or deployed. Each finding includes a suggested remediation for Jesse to evaluate and approve.

## Summary

| Severity | Count |
| --- | --- |
| Critical | 3 |
| High | 11 |
| Medium | 7 |
| Low | 3 |
| **Total** | **24** |

---

## Findings

### Critical

#### 1. Missing authentication (unauthenticated mutation)
- **File:** `apps/admin-legacy/server.js:10331`
- **Description:** `POST /api/pv/push-contacts` has NO `requireSession`/`requireAdmin` middleware. Any unauthenticated caller can push arbitrary `contact_ids` from the contacts DB into any PlusVibe workspace/campaign, leaking contact PII to external campaigns and triggering real outbound email sends. It also reads full contact records (email, phone, company, LinkedIn) via `db.getContactsById` and stamps `emailed_workspaces`.
- **Recommendation:** Add `requireSession` middleware: `app.post('/api/pv/push-contacts', requireSession, ...)`. This is a data-mutating, PII-exposing, external-side-effect route and must require a logged-in session.

#### 2. Missing authentication (credential exposure)
- **File:** `apps/admin-legacy/server.js:10458`
- **Description:** `GET /api/ev2/proxies` has NO auth middleware and returns full proxy rows including plaintext username and password for every proxy in `ev2_proxies`. Anyone who can reach the server can harvest the proxy credentials (proxy4smtp / Webshare creds).
- **Recommendation:** Add `requireSession` (or `requireAdmin` given these are infrastructure credentials). Consider stripping `password` from the response payload for the list view.

#### 3. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:10485`
- **Description:** `POST /api/ev2/proxies` has NO auth middleware. Unauthenticated callers can insert arbitrary proxy `host:port:user:pass` rows into the `ev2_proxies` pool, which are then used by the email verifier — allowing an attacker to route SMTP verification traffic through proxies they control (credential/traffic interception).
- **Recommendation:** Add `requireSession` (preferably `requireAdmin`) middleware to the proxy add route.

### High

#### 4. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:10509`
- **Description:** `DELETE /api/ev2/proxies/:id` has NO auth middleware. Unauthenticated callers can delete individual proxies from the pool.
- **Recommendation:** Add `requireSession`/`requireAdmin` middleware.

#### 5. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:10516`
- **Description:** `DELETE /api/ev2/proxies` (clear all) has NO auth middleware. Unauthenticated callers can wipe the entire proxy pool, disabling the email verification pipeline (denial of service).
- **Recommendation:** Add `requireSession`/`requireAdmin` middleware.

#### 6. Missing authentication (data mutation / external side effects)
- **File:** `apps/admin-legacy/server.js:10582`
- **Description:** `POST /api/ev2/verify` has NO auth middleware and accepts up to 5000 emails per request, fanning them out to the Reacher SMTP verifier through the proxy pool. An unauthenticated caller can use this as a free bulk email-verification engine, burn proxy quota, and trigger SMTP traffic from our infrastructure.
- **Recommendation:** Add `requireSession` middleware.

#### 7. Missing authentication (data mutation / external side effects)
- **File:** `apps/admin-legacy/server.js:12075`
- **Description:** `POST /api/contacts/verify-and-push` has NO auth middleware. Unauthenticated callers can start a background job that verifies contacts and pushes them into any PlusVibe workspace/campaign — same impact class as `/api/pv/push-contacts` (PII leak + real outbound sends).
- **Recommendation:** Add `requireSession` middleware.

#### 8. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:12568`
- **Description:** `POST /api/contacts/push-jobs/:id/cancel` has NO auth middleware. Unauthenticated callers can cancel any running push job (and DELETE its `paused_push_jobs` row), disrupting active contact pushes.
- **Recommendation:** Add `requireSession` middleware.

#### 9. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:12578`
- **Description:** `POST /api/contacts/push-jobs/:id/pause` has NO auth middleware. Unauthenticated callers can pause any running push job.
- **Recommendation:** Add `requireSession` middleware.

#### 10. Missing authentication (data mutation)
- **File:** `apps/admin-legacy/server.js:12590`
- **Description:** `POST /api/contacts/push-jobs/:id/resume` has NO auth middleware. Unauthenticated callers can resume paused push jobs, restarting outbound contact pushes.
- **Recommendation:** Add `requireSession` middleware.

#### 11. Hardcoded secret / API key
- **File:** `apps/admin-legacy/server.js:57`
- **Description:** `PLUSVIBE_KEY` has a hardcoded literal fallback value committed in source: `process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60'`. This is a real-looking production ESP (PlusVibe) API key checked into the git repo. Anyone with repo read access obtains a live API credential, and if the env var is ever unset the app silently uses this key.
- **Evidence:** `const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';`
- **Recommendation:** Remove the literal fallback (use `process.env.PLUSVIBE_KEY` with a fail-fast check if missing). Rotate/revoke this PlusVibe key immediately since it is exposed in git history, and purge it from history if feasible.

#### 12. Hardcoded secret / API key
- **File:** `apps/admin-legacy/server.js:61`
- **Description:** `NO2BOUNCE_KEY` has a hardcoded literal fallback committed in source: `process.env.NO2BOUNCE_KEY || 'ab55c5f1325ad50bf92850e030c16caa'`. This is a real-looking No2Bounce email-verification API token in the repo, used as the `apitoken` header on outbound API calls (lines 11857, 11881).
- **Evidence:** `const NO2BOUNCE_KEY = process.env.NO2BOUNCE_KEY || 'ab55c5f1325ad50bf92850e030c16caa';`
- **Recommendation:** Remove the literal fallback, require the env var, and rotate the No2Bounce token since it is exposed in git history.

#### 13. Weak default credentials / secret
- **File:** `apps/admin-legacy/server.js:51`
- **Description:** `JWT_SECRET` falls back to a hardcoded, guessable default (`'ottaly-dev-secret-change-in-prod'`) when the env var is unset. This secret is combined with `ADMIN_KEY` to form `SESSION_SECRET` (line 56) which signs all admin/manager session JWTs. If `JWT_SECRET` (and `ADMIN_KEY`) are unset in any deployment, an attacker who knows these public-in-git defaults can forge valid session tokens and gain admin access.
- **Evidence:** `const JWT_SECRET = process.env.JWT_SECRET || 'ottaly-dev-secret-change-in-prod';`
- **Recommendation:** Fail fast on startup if `JWT_SECRET` is unset in production rather than using a committed default. Ensure the production deployment sets a strong random `JWT_SECRET`; rotating it invalidates existing sessions (acceptable).

#### 14. Weak default credentials / secret
- **File:** `apps/admin-legacy/server.js:52`
- **Description:** `ADMIN_KEY` falls back to the hardcoded default `'ottaly-admin'` when the env var is unset. `ADMIN_KEY` is part of `SESSION_SECRET` (line 56) and gates admin auth; a committed default weakens session-token forgery resistance and may serve as a default admin password depending on how `requireAdmin` checks it.
- **Evidence:** `const ADMIN_KEY = process.env.ADMIN_KEY || 'ottaly-admin';`
- **Recommendation:** Require `ADMIN_KEY` via env with no committed fallback; fail fast if missing. Verify `requireAdmin` does not accept this literal in production and confirm the env var is set on all deployments.

### Medium

#### 15. Information disclosure (unauthenticated read)
- **File:** `apps/admin-legacy/server.js:12061`
- **Description:** `GET /api/contacts/push-jobs` and `GET /api/contacts/push-jobs/:id` (line 12068) have NO auth middleware. They expose recent push job state including `workspace_id`, `campaign_id`, `workspace_name`, `campaign_name` and progress/skip counts to unauthenticated callers.
- **Recommendation:** Add `requireSession` middleware to both read routes.

#### 16. Information disclosure (unauthenticated read)
- **File:** `apps/admin-legacy/server.js:9220`
- **Description:** `GET /api/pv/workspace-leads` has NO auth middleware. Given any `workspace_id` it proxies to PlusVibe and returns that workspace's leads (names, emails, lead labels) using our server-side `PLUSVIBE_KEY`. Unauthenticated callers can enumerate client lead data without their own API key.
- **Recommendation:** Add `requireSession` middleware.

#### 17. Information disclosure (unauthenticated read)
- **File:** `apps/admin-legacy/server.js:10304`
- **Description:** `GET /api/pv/workspaces` (and `GET /api/pv/campaigns` at line 10317) have NO auth middleware. They use the server-side `PLUSVIBE_KEY` to list all client workspaces and their campaigns to any unauthenticated caller, leaking the full client/campaign roster.
- **Recommendation:** Add `requireSession` middleware to both routes.

#### 18. Broken access control (manager can access Revenue)
- **File:** `apps/admin-legacy/server.js:2646`
- **Description:** `GET /api/revenue/leads` uses `requireSession` (manager-accessible) and returns full revenue data: per-lead prices and the `revenueCache`. Per policy managers must NOT see Revenue/Finance. Finance routes correctly use `requireAdmin`, but the Revenue family is inconsistently gated, letting managers read agency revenue.
- **Recommendation:** If managers must not see revenue, change to `requireAdmin`. (Confirm intent — workspace pricing may be needed for commission, but raw revenue totals likely should be admin-only.)

#### 19. Broken access control (manager can access Revenue)
- **File:** `apps/admin-legacy/server.js:2696`
- **Description:** `GET /api/revenue/stats-by-workspace` uses `requireSession` instead of `requireAdmin`. It computes per-workspace revenue totals (`price_per_lead x leads`), which is Revenue data managers should not see per policy.
- **Recommendation:** Change to `requireAdmin` if revenue is admin-only.

#### 20. Broken access control (manager can access Revenue)
- **File:** `apps/admin-legacy/server.js:2622`
- **Description:** `GET /api/avg-lead-price` uses `requireSession` and returns `total_revenue` and `avg_lead_price` across all workspaces — agency-wide revenue figures exposed to managers.
- **Recommendation:** Change to `requireAdmin` if revenue is admin-only.

#### 21. Missing authentication / input validation on external-input write endpoint
- **File:** `apps/admin-legacy/server.js:11752`
- **Description:** The `/webhook/plusvibe-reply` POST endpoint has no signature or shared-secret verification (unlike `/webhook/lead` at line 1954 which conditionally checks `x-webhook-secret`, and the Stripe webhook at line 378 which verifies the signature). Any unauthenticated caller can POST arbitrary JSON, which is written to the `webhook_events` table and fed into `processWebhookEvent` (reply-intelligence parsing, contact/status updates). This allows spoofed reply/bounce events and unbounded junk inserts. Field extraction is defensive (many fallbacks) but there is no validation that the payload is genuine.
- **Evidence:** `app.post('/webhook/plusvibe-reply', (req, res) => { res.json({ ok: true }); const body = req.body; ... db.prepare(`INSERT INTO webhook_events ...`).run(eventType, email.toLowerCase(), JSON.stringify(body)); processWebhookEvent(...)`
- **Recommendation:** Add a shared-secret header or HMAC signature check (as PlusVibe/EmailBison support) before accepting the payload, and reject events that lack a recognizable email/event shape. Rate-limit the endpoint.

### Low

#### 22. Broken access control (admin-namespaced destructive op on requireSession)
- **File:** `apps/admin-legacy/server.js:1840`
- **Description:** `POST /api/admin/clear-snoozes` is under the `/api/admin/` namespace but uses `requireSession`, so any manager can bulk-wipe `snoozed_verticals` and `reply_notes` across ALL contacts. Most other `/api/admin/` mutation routes use `requireAdmin`; this destructive bulk operation is inconsistent.
- **Recommendation:** Confirm whether managers should perform this bulk wipe; if not, change to `requireAdmin` to match the rest of the `/api/admin/` mutation routes.

#### 23. Unbounded query
- **File:** `apps/admin-legacy/server.js:1209`
- **Description:** In `POST /api/admin/enrich/start`, the limit defaults to 0, which produces an empty `limitClause`, so the subsequent query selects `DISTINCT company_domain/company_name` across the entire contacts table (267k+ rows per in-file comments) with no LIMIT and loads all rows into memory (`rows.length` used as `job.total`). Admin-gated and injection-safe (`parseInt`), but a missing/zero limit triggers a full-table scan and large in-memory result by default.
- **Evidence:**
  ```
  const limitClause = limit > 0 ? `LIMIT ${parseInt(limit, 10)}` : '';
  SELECT DISTINCT ON (company_domain) company_domain, company_name FROM contacts WHERE ... ${limitClause}
  ```
- **Recommendation:** Apply a sane hard cap (e.g. LIMIT clamped to a maximum) or iterate via keyset pagination (the pattern already used at `server.js:1499`) instead of materializing the whole table when limit is 0.
