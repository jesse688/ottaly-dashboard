# Ottaly Dashboard — Roadmap & Build Log

Live doc. Updated after every feature ships. Covers what's built, what's planned, and what phase each system is in.

---

## 1. Audience Scoring — Lookalike TAM Scorer

**Goal:** For each client, score every unsent contact in the database by how closely they match the profile of people who have already replied or become a lead. Replaces random/manual batch selection with data-driven recommendations.

### How it works
1. **Responder profile** — pulls all replied/lead contacts for a workspace from two sources: PlusVibe webhook events (`email_events` table) and the contact's `pushed_campaigns` + status fields
2. **Scoring** — scores each unsent contact 0–100 across 5 dimensions (seniority, department, industry, country, company size). 20 points per dimension match
3. **Recommendation** — surfaces the top-N contacts via a panel in the Contacts page

### Shipped ✅
| Commit | What |
|--------|------|
| `778764c` | DB tables (`audience_scores`, `client_audience_profiles`) + `computeAudienceScores()` method |
| `48a4bed` | `POST /api/audience/seed-responders` — backfill historical replies from CSV export |
| `19d221d` | Recommended Batch button on Contacts page (selection bar — later moved) |
| `7d5d153` | Moved Recommended Batch panel into Client Filter section (select client → panel appears) |
| `59b39f9` | `POST /api/audience/refresh-all` endpoint + "Refresh All Client Profiles" button |
| `7e099dc` | Auto-seed from PlusVibe API (no CSV needed) + **daily 6am cron** that runs for all clients |

### Daily cron (6am)
For every client workspace:
1. Pulls all REPLIED / LEAD / INTERESTED / MEETING_BOOKED contacts from PlusVibe API
2. Seeds them as responders in the database
3. Recomputes scores for every unsent contact

### Accrue seeding (one-time, done ✅)
Accrue had no webhook history. Manually exported 126 replied contacts from PlusVibe CSV, seeded via `seed-responders` endpoint. Result: 125 responders, 17,821 contacts scored. Profile: UK founders, 1–10 employees, IT/consulting/staffing, C-Suite/Director.

### How to use (Contacts page)
1. Select a client from **Filter for Client** dropdown
2. Green **✨ Recommended Batch** panel appears in the sidebar
3. Set batch size (max 200) and min score (80 = high confidence, 60 = decent)
4. Click **Load Recommended Contacts** → contacts pre-selected
5. Click **🚀 Push to PlusVibe** as normal

### Planned — Phase 2
- [ ] A/B validation: compare reply rate for score ≥80 vs score 60–80 batches over 2 weeks
- [ ] Per-client model switches to logistic regression once client has 30+ replies + 500+ sends
- [ ] Audience slice diversification (Thompson sampling across 8–10 ICP segments)

### Planned — Phase 3
- [ ] Cross-client bootstrap — new clients borrow from similar clients' responder profiles until they have their own data (threshold: 10+ replies)

---

## 2. Client Health

**Goal:** Daily AI-briefed health score per client. Surfaces problems (bounce spikes, copy decay, behind-pace leads) with concrete, checkable actions rather than vague advice.

### Shipped ✅
| Commit | What |
|--------|------|
| `831c5d8` | `health_actions` table — every AI action becomes a tracked row |
| `70d44b4` | Monthly lead target tracking + behind-pace detection |
| `d15d34a` | Daily health snapshots + AI briefings + template-decay detector |
| `9f4eaf8` | Honest AI/fallback labels (shows whether briefing came from Claude or deterministic fallback) |
| `33b6df2` | Actionable briefings Phase 1 — concrete actions with campaign names, not generic advice |
| `008704b` | Outcome evaluator — checks 24h later if actioned items moved the target metric |
| `e9e82de` | Copy-staleness detection using live campaign data; active campaign list injected into AI signals; server-side action quality gate strips soft-language |

### How the health score works
- Built from: reply rate 7d vs 30d baseline, bounce rate, lead pace vs target, mailbox health, domain health, open copy alerts
- Score 0–100 → band: Critical / At Risk / Needs Attention / Good / Excellent
- AI briefing explains why the score moved; AI actions are concrete and campaign-specific
- Fallback: if Claude is unavailable, deterministic actions are generated from signals

### Planned
- [ ] Template decay alerts surfaced as health actions (when a subject line's reply rate drops >50% vs its historical baseline)
- [ ] Cross-client copy analysis (same template used across multiple clients)

---

## 3. Finance & P&L

**Goal:** Full agency P&L — revenue, mailbox infra costs, operating expenses, and staff costs — in one view per month.

### Shipped ✅
| Commit | What |
|--------|------|
| `52b5265` | Manager base salary + commission as staff expense line in finance P&L |

### How staff costs work
- **Base salary** — fixed monthly amount set per manager in Admin → Campaign Managers
- **Commission** — manager's commission rate (%) × revenue from their assigned clients that month
- Commission rate now lives on the **manager**, not the client (client `commission_rate` field kept for legacy commission.html page only)
- Finance page shows a **Staff costs** KPI card: total salary + commission, with per-manager breakdown

### Finance KPIs (left → right)
Revenue → Mailbox infra → Gross profit → Other expenses → Staff costs → Net profit → Net margin

### Planned
- [ ] Staff cost trend line on the 12-month chart
- [ ] Per-manager P&L view (revenue managed, commission earned, margin contribution)

---

## 4. Infrastructure & Core

### Shipped ✅
| Commit | What |
|--------|------|
| `78e94cf` | Performance cache persisted to Postgres — survives restarts |
| `70cf214` | Mailboxes: per-provider trend charts (Google / Microsoft / SMTP) with 3d avg |
| `56d0050` | Critical bug fixes + new shared resources (nav.js, favicon, brand SVGs) |
| `957bc34` | Dashboard sweep: shared nav + favicon + meta tags + splash.js on all pages |
| `43b17cf` | Stats: label chart smoothing as '3-day rolling avg' |
| `bd4a40a` | Stats: fix Human RR going negative (double-subtraction of OOO bug) |

### Dashboard cleanup audit — 2026-05-20

Audit of 18 HTML pages (~16k LOC) surfaced 27 findings across bugs, nav
consistency, brand drift, missing meta, and accessibility. Most are
fixed; the remaining items live in the audit status table below.

**What landed in the four cleanup commits:**
- `did yo` typo at top of `performance.html` — gone
- Invalid `flex-wrap:gap` in `clients.html` — fixed to `wrap` + `gap`
- 5 production `console.log` calls removed from `contacts.html` / `finance.html`
- ~3,000 lines of duplicated inline nav HTML removed — replaced with `<a id="ottaly-logo">` + `<nav id="ottaly-nav">` placeholders filled by `/nav.js`
- Apollo Prep, DMARC, Automation, Email Verify, My Commission — were orphaned, now reachable from every page
- Stats nav style drift / commission.html "Contacts" mislabel — both fixed by virtue of using the shared nav
- Brand logo with otter mascot served locally from `/assets/logo-white.svg` (was hot-linking framerusercontent.com); favicon + theme-color + meta description + splash.js on every page

### Decisions needed from Jesse

Asked 2026-05-20, no answer yet:

- **(a) Stats header "Reply Rate" semantics** — currently `replies / sent`. Under the codebase's convention that's *human* reply rate. Leave as-is (mislabelled) or change to `(replies + oooReplies) / sent` (total, matches chart's new "Reply Rate" toggle and Performance page's `replyWithOOO`)?
- **(b) Period filters** — pick one canonical set across all pages. Options: Stats-style (Today/7d/14d/30d/Week/Month/Year/Custom) or Revenue-style (Today/Yesterday/Week/Month/All/Custom).
- **(c) Two pages still look different** — `contacts.html` (DataBase 1.0 with white sidebar, system fonts) and `email-verify2.html` (own teal `#16817a` and `#111827` header). Harmonise with the design system or leave as intentional "tool" treatments?
- **(d) Replace `alert()` popups with toasts?** 8 in `admin.html`, 3 in `index.html`, 4 in `email-verify2.html`. Every page already has a `.toast` class.

### Known issues / followups

- **`health.html` 404** — added to `nav.js:7` ("Client Health") but the page doesn't exist on disk. Either build it (see Backlog) or remove the nav entry.
- **Header right-side content varies per page** — live status, last update, session badge, etc. Not yet standardised.
- **Stale per-page CSS classes** — some pages still define unused `.nav-tab`, `.nav-tabs`, `.logo` rules. Inert but bloats the page.

### Audit findings status

Numbering matches the original 2026-05-20 audit report.

| #  | Finding                                                  | Status     |
|----|----------------------------------------------------------|------------|
| 1  | `did yo` typo in performance.html                        | ✅ `56d0050` |
| 2  | `flex-wrap:gap` invalid CSS in clients.html              | ✅ `56d0050` |
| 3  | Orphaned pages (Automation, Email Verify, DMARC, Commission) | ✅ `957bc34` via `nav.js` |
| 4  | Apollo Prep missing from 5 navs                          | ✅ `957bc34` via `nav.js` |
| 5  | commission.html nav says "Contacts" not "DataBase 1.0"   | ✅ `957bc34` via `nav.js` |
| 6  | Stats nav link mis-styled on every page                  | ✅ `957bc34` via `nav.js` |
| 7  | Body background drift (5 colours)                        | ⏳ backlog |
| 8  | Brand color drift (teal/navy variants, hex casing)       | ⏳ backlog |
| 9  | Logo treatment varies                                    | ✅ `957bc34` |
| 10 | contacts / email-verify2 look different                  | ⏸ decision (c) |
| 11 | Nav reimplemented per page                               | ✅ `957bc34` |
| 12 | No favicon                                               | ✅ `957bc34` |
| 13 | No meta description                                      | ✅ `957bc34` |
| 14 | No Open Graph tags                                       | ⏳ partial — description only, no `og:` |
| 15 | Splash.js missing on 15 of 18 pages                      | ✅ `957bc34` |
| 16 | No theme-color meta                                      | ✅ `957bc34` |
| 17 | Period filters vary                                      | ⏸ decision (b) |
| 18 | `alert()` used for errors                                | ⏸ decision (d) |
| 19 | Logout placement varies                                  | ⏳ open |
| 20 | Production `console.log` leftovers                       | ✅ `56d0050` |
| 21 | No global search / Cmd-K palette                         | ⏳ strategic |
| 22 | Extract shared CSS                                       | ⏳ backlog |
| 23 | Extract shared nav include                               | ✅ `56d0050` + `957bc34` |
| 24 | Mobile responsive holes                                  | ⏳ backlog |
| 25 | Accessibility                                            | ⏳ backlog |
| 26 | Large files (contacts 3995, index 1977 lines)            | ⏳ low priority |
| 27 | Hardcoded webhook URL in index.html                      | ⏳ low priority |

### Database
- **SQLite** — clients, managers, leads, transactions, webhook events, auth
- **Postgres** (Netcup Easypanel, 4 vCPU / 8GB) — contacts (database1.0), email_events, campaign_templates, health snapshots, audience scores
- Postgres tuned via `ALTER SYSTEM`, not env vars

### Key infra
- Reacher (email verification) — SOCKS5 via proxy4smtp.com, concurrency capped at 5
- PlusVibe webhook path: `/webhook/plusvibe-reply`
- Easypanel services: `ottaly_ottaly-postgres`, `reacher` on port 80

---

## 5. Contacts (Database 1.0)

**Goal:** Central contact database across all clients — TAM management, email verification, deduplication, push to PlusVibe.

### Key features (shipped)
- Import from Apollo CSV
- Email verification via Reacher
- Per-client cooldown (90 days) — tracked in `emailed_workspaces` JSONB
- Push dedup via `pushed_campaigns` JSONB (per campaign, per workspace)
- Saved views / campaign filter recall
- DNC, snoozed verticals, vertical-aware filtering
- **Audience scoring panel** (see Section 1)

### Reply intelligence — cross-vertical DNC signals (2026-05-26)
Webhook reply parser now detects two new signals on top of existing unsubscribe/vertical-snooze logic. Both bypass per-vertical scoping because the contact/company is permanently unreachable, not just sorted for one service.

| Signal | Phrasing examples | Effect |
|--------|-------------------|--------|
| Recipient left company | "I no longer work here", "I've left the company", "former employee", "this mailbox is no longer monitored", "I retired" | `do_not_contact=true` on the replying contact (global, all verticals) |
| Company closed | "ceased trading", "in administration / liquidation", "out of business", "company has been dissolved", "closed/shut down" | `do_not_contact=true` on every contact sharing `company_domain` (domain-wide, all verticals); `reply_notes` annotated with the source email |

Implementation: `parseReplyIntelligence()` in [server.js:7278](server.js#L7278) returns `_leftCompany` / `_companyClosed` markers; `processWebhookEvent()` fans the closed-company case out to all sibling contacts at the same domain in a single UPDATE.

### Search hides 90-day cooldown contacts (2026-05-26)
When **Filter for Client** is selected, the contacts search now excludes rows already emailed by that workspace in the last 90 days — the same filter `/api/pv/push-contacts` was applying at push time. Previously these rows showed up in results and got silently skipped on push, wasting verification + push time.

- `_buildFilterClauses()` ([db-postgres.js](db-postgres.js)) gains a `cooldownWorkspace` clause: `NOT (emailed_workspaces ? $ws AND last_sent >= today-90d)`
- `clientFilter` value flows through `getFilterValues()` as `cooldownWorkspace` ([contacts.html](contacts.html))
- New GIN index `idx_contacts_emailed_workspaces_gin` (jsonb_path_ops) makes the `?` lookup index-backed for the COUNT query

### Per-client Master Exclusions (2026-05-26)
Clients page → Edit Client → new **Master Exclusions** section. Six comma-separated lists (industries, company sizes, keywords, counties, cities, job titles) that the contacts page enforces automatically whenever this client is the selected filter target. Use case: client says "don't target anyone in London / don't pitch any accountants" — set it once on the client record, can't be bypassed by operators on the contacts UI.

- Storage: 6 new TEXT columns on `client_verticals` (SQLite). Saved canonically (trimmed, deduped) via [POST /api/admin/client-verticals](server.js).
- Enforcement: `/api/contacts/search` looks up the row when `cooldownWorkspace` is set and merges into the filter object — user-typed excludes layer on top, master excludes can't be disabled from the contacts page.
- New filter clauses in `_buildFilterClauses`: `cityExclude`, `stateExclude`, `countryExclude` (match person + company columns), `numEmployeesExcludeRanges` (same bucket grammar as include).
- New session-protected lookup [`/api/client-rules/:workspace_id`](server.js) lets the contacts page show a live count chip: "🚫 Master exclusions: 3 industries, 2 cities, …" so operators see what's filtered.

---

## 6. Google Maps Scraper + SME Lead Enrichment Pipeline

**Goal:** Build a lead pipeline for UK SMEs that aren't on Apollo. Google Maps → Companies House directors → email finding → PlusVibe. Apollo misses most SMEs; this fills that gap.

**Researched 2026-06-02. Not yet started.**

### Pipeline design

```
Google Maps (name, address, website)
    → Companies House API (directors: first + last name)
    → Email waterfall (Apollo → pattern guesser + Reacher → Anymail Finder)
    → PlusVibe / contacts DB
```

### Stage 1 — Google Maps scraping

**Best option: [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)** (Go + Playwright, 4,200+ stars, updated May 2026)
- Outputs: name, address, phone, website, category, coordinates
- PostgreSQL output — plugs into existing Netcup Postgres
- ~120 places/minute at concurrency 8
- SOCKS5 proxy support (existing proxy4smtp proxies work)
- Docker-friendly

**The 120-result cap:** Google hard-caps at 120 results per search query. Workaround: **geographic grid subdivision** — tile city into a 3×3 grid, search each cell → up to 1,080 results per keyword.

**Recommended start: Outscraper** ($3/1K records, 500 free) — zero-ops, use to validate pipeline before self-hosting gosom.

**Official Google Maps API:** Not worth it — ~$18.60/1K records vs $3/1K via Outscraper.

### Stage 2 — Companies House enrichment

Free REST API: `api.company-information.service.gov.uk` (API key required, free to register)

Steps:
1. Search by company name: `GET /search/companies?q={name}&items_per_page=5` → filter `company_status=active`
2. Fuzzy-match (Jaro-Winkler ≥ 85%) + postcode cross-check vs Google Maps address
3. Fetch directors: `GET /company/{number}/officers?register_type=directors` → filter `resigned_on=null`
4. Parse "SMITH, James" format → first + last name

Rate limit: 600 req/5 min per key. Register 3 keys → ~2,000 companies/hour. Free.

**Key gotchas:**
- ~35–45% of Maps businesses are sole traders — no Companies House record (handle separately; PECR requires consent for sole traders, not just legitimate interest)
- Same name, multiple companies — use postcode as tiebreaker
- Always filter `company_status=active` — dissolved companies return 200 OK with no error
- Names come back "SURNAME, Firstname" — need normalisation
- LLPs: partners are `officer_role = "llp-designated-member"`, not director

### Stage 3 — Email finding (waterfall)

| Layer | Cost | Expected hit rate |
|-------|------|-------------------|
| Apollo enrichment (existing subscription) | ~$0 | ~20–30% |
| Pattern guesser + Reacher (self-build, ~50 lines) | ~$0 | +20–25% |
| Anymail Finder API (charges only on verified finds) | $0.073/email | +5–10% |

**Catch-all domains (~25% of SMEs):** Reacher detects these automatically. Skip SMTP guessing for catch-all domains and fall back to Apollo/Anymail Finder.

**Reacher throughput:** At concurrency 5 (existing cap), ~100K SMTP checks in ~5.5 hours. Run as overnight batch job.

### Build vs buy summary

| Component | Decision | Cost |
|-----------|----------|------|
| Maps scraping | gosom (self-hosted) or Outscraper | ~$30–175 per 10K |
| Companies House | Custom client (trivial to build) | Free |
| Email pattern generator | ~50 lines of code | Free |
| SMTP verification | Reacher (already running) | Free |
| Email DB lookup | Apollo (existing) → Anymail Finder fallback | Existing sub + ~$22 |

### Expected hit rates (per 10K Maps listings)

| Stage | Output | Rate |
|-------|--------|------|
| Has website field | 6,500 | 65% |
| Matches active CH company | 3,575 | 55% of previous |
| Active director found | 3,396 | 95% of previous |
| Email verified | ~1,530 | 45% of previous |

**~14–15% of Maps listings → outreach-ready lead with verified email**
**Cost: ~$0.035/lead (Outscraper) to ~$0.15/lead (self-hosted)**

### PECR compliance note
- UK Ltd / LLP directors = corporate emails → legitimate interest (Article 6(1)(f)) is valid basis for cold email
- Sole traders / partnerships = treated as individuals → require consent; segment these out
- Document a Legitimate Interest Assessment (LIA) before launching at scale

### Planned build order
- [ ] **Step 1:** Test Outscraper — 500 free records for one target niche/city, validate data quality
- [ ] **Step 2:** Build Companies House enrichment service (Node.js client, Redis cache 30 days, 3 API keys)
- [ ] **Step 3:** Build email pattern guesser + wire to existing Reacher + Apollo enrichment waterfall
- [ ] **Step 4:** Store enriched leads in contacts DB (flag `source=google_maps`)
- [ ] **Step 5:** Deploy gosom on Netcup once pipeline is validated at Outscraper scale

---

## 7. Root Cause Analyzer — Diagnostic System

**Goal:** When performance dips, instantly identify the root cause (campaign quality vs delivery vs email health vs external factor).

**Status:** ✅ Plan 100% complete. Phase 0 (data validation) ready. Phase 1 build pending validation gates.

**How it works:**
1. Collect 6 signal categories: email account health, infrastructure, PlusVibe API, campaign metrics, bounce analysis, external factors
2. Decision tree (7+ rules) isolates root cause from signals
3. Dashboard: 30-day timeline + metrics snapshot + ranked hypotheses with confidence

**Phases:**
| Phase | What | Days | Risk | Status |
|-------|------|------|------|--------|
| 0 | Data validation — run 7 gates | 0.25 | Low | ⏳ Pending |
| 1 | Signal collection — tables + instrumentation | 2–3 | Low | 📋 Planned |
| 2 | Diagnostics dashboard — timeline + metrics + tree | 1–2 | Low | 📋 Planned |
| 3 | Decision rules + daily correlation | 2–3 | High | 📋 Planned |
| 3b | Intelligence collection — pattern mining + daily logs | 1 | Medium | 📋 Planned |
| 3c | Intelligence pattern correlation queries | 1 | Medium | 📋 Planned |
| 4 | Intelligence dashboard — tiers, drivers, predictions | 1.5 | Low | 📋 Planned |
| 4b | Predictive model (logistic regression) | 2 | High | 📋 Optional |
| 4c | Integration: Client Health + email digest | 1 | Low | 📋 Optional |

**MVP = Phases 0–3c = Root cause analyzer + pattern intelligence = ~1.5 weeks**
**Full system = Phases 0–4c = All above + predictive intelligence = ~2.5 weeks**

**Documentation:**
- DIAGNOSTIC_SYSTEM.md — root cause analyzer architecture + signals + tables
- DIAGNOSTIC_PLAN.md — detailed phase-by-phase implementation
- DIAGNOSTIC_INTELLIGENCE.md — pattern learning + performance intelligence system
- DIAGNOSTIC_VALIDATION.md — data validation approach
- PRE_IMPLEMENTATION_CHECKLIST.md — gates + recovery steps
- PLAN_SUMMARY.txt — TL;DR

**Key concepts:**
- **Root cause analyzer** (Phases 1–3): Identifies why performance dropped on a given date
- **Performance intelligence** (Phases 3b–4c): Learns patterns from good + bad days, predicts performance, recommends actions

**Critical gates:**
Gate 1–7 in PRE_IMPLEMENTATION_CHECKLIST.md. All must pass before Phase 1.

**Next:** Run Phase 0 validation gates. Proceed only if all pass. Then start Phase 1 implementation.

---

## Backlog / Ideas discussed but not yet scoped

- [ ] Per-client audience slice testing (score 80–100 vs 60–80 comparison batches)
- [ ] Nightly email to account manager with client health summary
- [ ] Stripe billing integration for client invoicing
- [ ] Lead pipeline view (lead → meeting booked → closed) with conversion rates

### Dashboard polish backlog (from cleanup audit)

Safe to pick up without further discussion. Ranked by impact.

1. **Remove the `health.html` nav entry** (or build the page — see Strategic below).
2. **Standardize body background colours** — 5 variants exist (`#F8F9FC`, `#F0F2F8`, `#f0f2f5`, `#f3f6fb`, `#f8f9fa`). Pick one, search-and-replace.
3. **Normalize hex casing** — `#9CA3AF` (68×) and `#9ca3af` (32×) coexist.
4. **Extract shared CSS to `/styles.css`** — design tokens, header, buttons, cards, tables, toast, modal. Every page redefines these. ~3,000 more lines could be deduped. Multi-hour refactor but unblocks consistent theming.
5. **Mobile responsive pass** — nav wraps OK now, but Mailboxes/Finance tables don't collapse on narrow screens.
6. **Accessibility pass** — modal close buttons need `aria-label`, status colours need a non-color signal, etc.

### Strategic — need buy-in before starting

- **Build `health.html`** — Client Health overview pulling reply rate / bounce rate / blacklist / DMARC status per client. Currently linked from `nav.js:7` but returns 404.
- **Global Cmd-K palette** — jump-to-client, jump-to-campaign, jump-to-page. Half-day of work.
- **`README.md` / `CLAUDE.md`** — there's no doc explaining where things live, what `nav.js` / `splash.js` do, what conventions to follow.
- **Harmonise `client.html` (client portal)** — currently treated as a separate app. Could share the same brand assets / design tokens.

---

## Bounce Analyzer — earlier detection of list + sender problems

**Goal:** Stop treating "bounces" as one number. Split every bounce into **hard** (dead address → bad list), **block** (gateway rejecting *us* → reputation/policy), and **soft** (temporary), surface that split everywhere bounces appear, and alert when a client's hard-bounce rate starts rising — so list/sender issues are caught before deliverability drops.

### How it works
- One shared classifier (`bounce-classify.js`) parses the SMTP reason in `email_events.raw->>'msg'` (no stored type). Same validated regexes the gateway report used (~98% coverage; block ≈70%, hard ≈24%, soft ≈5%). Order: block > hard > soft.
- All four surfaces (analyzer page, Stats, Mailboxes, alert) derive from that single source — tune the regex once, everything updates.
- Bounce events are webhook-partial, so absolute counts are directional; the **ratio** hard:block:soft is the reliable signal. Stats keeps the Bison total as authoritative and only overlays the split.

### Shipped ✅ (branch `feat/bounce-analyzer`, off `stable`)
| Phase | What |
|-------|------|
| 0 | `bounce-classify.js` — single source of truth (regexes + `bounceClassCase`/`bounceClassExprs`/`classifyBounce`); refactored `/api/gateway-analysis` to use it (behavior-preserving; resolves an accidental regex drift in the old soft exclusion) |
| 1 | New `bounce-analysis.html` + `/api/bounce-analysis` (+`/explorer`): summary cards w/ WoW deltas, hard/block/soft trend chart, by-client + by-campaign split, hard-domain & hard-address triage, sender-health (block-by-mailbox), paginated raw explorer. Nav: Stats → Bounces |
| 2 | Stats page: 3 new opt-in series (Hard %, Block %, Soft %) via `/api/stats/bounce-breakdown`, merged additively into each day point. Bison Bounce Rate untouched & still authoritative |
| 3 | Mailboxes page: per-mailbox `NH NB NS` micro-split under the bounce rate, from `buildMailboxStatsFromEvents` (real classification, webhook path only) |
| 4 | `/api/cron/bounce-alert` — flags clients whose hard-bounce share is above a floor AND rising vs baseline; posts to Slack (CRON_SECRET-guarded, cron-job.org). Dashboard "Check alerts" does a dry run |

### Decisions resolved
- **3-way split (hard/block/soft), not 2-way** — Jesse, 2026-06-16. Block is the majority and means something different (sender reputation, not bad list); collapsing it into hard is the exact mistake to avoid.

### Follow-ups / not yet done
- **Bison reconciliation** — pull `status=bounced` leads per workspace to show "classified X of Y Bison-reported bounces (Z% coverage)". Planned for the page's coverage strip; needs the paginated Bison fetch (ignores `per_page`).
- **Wire the cron** — add `/api/cron/bounce-alert?secret=…` to cron-job.org once `CRON_SECRET` is set in Easypanel, and pick the alert channel (`SLACK_ALERT_CHANNEL_ID`, falls back to `SLACK_CHANNEL_ID`).
- **Tune thresholds** after seeing real flagged volume (`minHard`/`floorRate`/`risePct` are query-overridable).

---

## How this doc gets updated

- Claude reads ROADMAP.md at the **start** of any dashboard session.
- At the **end** of any session that ships commits, gets decisions resolved, or surfaces new findings — Claude updates this doc and commits it.
- New commits go to the top of each section's "Shipped" table.
- When Jesse answers a decision, it moves from "Decisions needed" to a "Resolved decisions" section (or just into the relevant fix's commit row).
