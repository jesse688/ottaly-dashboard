# company-service

Company-centric data service. Resolves each **domain's** Companies House identity,
business ownership (PSC), and building ownership **once per company**, then stamps
the result across every contact on that domain. Supersedes the per-contact CH
verification in admin-legacy.

## Why per-company, not per-contact

CH identity belongs to the company, not the person. A 40-contact domain used to
resolve the same company 40× and match on a fuzzy company *name*. Here we resolve
once and match on the strongest possible signal: a **decision-maker's name against
the company's registered officers / PSC**. Roughly ~28h per full pass over all
domains vs ~10 days per-contact.

## The resolve (one domain, one CH resolve → three answers)

1. Take the domain's most senior contacts (from `contacts.seniority`).
2. Search CH for the company → fetch **officers** + **PSC** for the candidates.
3. Match a senior contact's name to an active officer/PSC → **authoritative** company id.
4. Confirm with registered-office postcode (outcode-tiered).
5. **Business ownership** falls out of the same fetch: a PSC = >25% control.
6. **Building ownership**: registered postcode → Land Registry CCOD (later phase).
7. Stamp all contacts on the domain, provenance = `anchor` | `inherited` | `unresolved`.

Fallback when no officer/PSC matches: confident company-name + postcode (`low`),
else `none` (number cleared — never leave a wrong one).

## Status: Phase 0/1 (shadow mode)

Currently exposes on-demand single-domain resolve for validation. Writes the
`companies` table only; does **not** stamp `contacts.ch_*` unless `?stamp=1`.

- `GET  /health`
- `POST /refresh?domain=acme.co.uk` — resolve one domain (add `&stamp=1` to write back)
- `GET  /company?domain=acme.co.uk` — read the resolved row
- `GET  /status` — resolved counts + breakdown by match_method/confidence

Not yet built (later phases): the queue/worker continuous loop, CCOD building-
ownership step, scheduler, admin-legacy UI.

## Deploy (EasyPanel)

New App service, Build Path `/`, Dockerfile `apps/company-service/Dockerfile`,
branch `stable`. **Bump the `CACHEBUST` ARG in the Dockerfile each deploy** —
EasyPanel's cache reuses a stale source `COPY` layer otherwise. Env: see
`.env.example`. Shares the same Postgres and CH key as admin-legacy — mind the
600 req/5min budget split (`CH_MIN_INTERVAL_MS`).
