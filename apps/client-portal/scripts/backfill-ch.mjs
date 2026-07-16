// Backfill Companies House data onto replied portal leads that lack it.
//
// Mirrors the production resolver in lib/companies-house.ts EXACTLY:
//   - number-first, then exact ACTIVE-name match only, skip-if-uncertain
//   - never guesses; ambiguous / no-match leads are left empty (reason recorded)
// Only touches REPLIED leads (esp_leads.first_replied_at IS NOT NULL) — those are
// the portal-facing leads; the 34k unreplied leads are intentionally skipped.
//
// Merges resolved fields into esp_leads.raw (COALESCE || jsonb — never blanks
// existing keys) and records raw->>'ch_enrich_reason' for auditability.
//
// Usage:
//   COMPANIES_HOUSE_API_KEY=xxx DATABASE_URL=postgres://... node scripts/backfill-ch.mjs [--commit] [--workspace <id>] [--limit N]
//
// Runs DRY by default (resolves + prints, writes nothing). Pass --commit to write.

import pg from 'pg'

const args = process.argv.slice(2)
const COMMIT = args.includes('--commit')
const WORKSPACE = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null

const CH_KEY = process.env.COMPANIES_HOUSE_API_KEY
const DB_URL = process.env.DATABASE_URL
if (!CH_KEY) { console.error('FATAL: COMPANIES_HOUSE_API_KEY not set'); process.exit(1) }
if (!DB_URL) { console.error('FATAL: DATABASE_URL not set'); process.exit(1) }

const API = 'https://api.company-information.service.gov.uk'
const authHeader = { Authorization: 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64') }

// ── Rate-limited CH fetch: ~2 req/s, one 429 retry (matches lib) ──────────────
const MIN_INTERVAL_MS = 420
let lastCall = 0
async function chFetch(path) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCall = Date.now()
  const doFetch = async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12_000)
    try { return await fetch(`${API}${path}`, { headers: authHeader, signal: ctrl.signal }) }
    finally { clearTimeout(timer) }
  }
  let res = await doFetch()
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '2')
    await new Promise(r => setTimeout(r, Math.max(1, retryAfter) * 1000))
    lastCall = Date.now()
    res = await doFetch()
  }
  if (res.status === 404) return null
  if (!res.ok) { console.error(`[ch] ${path} → ${res.status}`); return null }
  return await res.json()
}

// ── Normalization + resolution (verbatim logic from lib/companies-house.ts) ───
function normName(s) {
  return s.toLowerCase()
    .replace(/\b(limited|ltd|llp|plc|inc|co|company|holdings|group|uk)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

async function buildRundown(companyNumber, matchedBy) {
  const profile = await chFetch(`/company/${encodeURIComponent(companyNumber)}`)
  if (!profile || !profile.company_number) return null
  const officers = await chFetch(`/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=35`)
  const active = (officers?.items ?? [])
    .filter(o => !o.resigned_on)
    .map(o => ({ name: o.name ?? '', role: o.officer_role ?? '', appointed_on: o.appointed_on ?? null }))
  const status = profile.company_status ?? null
  const addr = profile.registered_office_address ?? {}
  const registered_address = [addr.address_line_1, addr.address_line_2, addr.locality, addr.region, addr.postal_code, addr.country]
    .map(x => (x ?? '').trim()).filter(Boolean).join(', ') || null
  return {
    company_number: profile.company_number,
    company_name: profile.company_name ?? null,
    company_status: status,
    company_type: profile.type ?? null,
    incorporated_on: profile.date_of_creation ?? null,
    registered_address,
    sic_codes: profile.sic_codes ?? [],
    companies_house_url: `https://find-and-update.company-information.service.gov.uk/company/${profile.company_number}`,
    endole_url: `https://www.endole.co.uk/company/${profile.company_number}`,
    matched_by: matchedBy,
    active_officers: active,
    dissolved: status === 'dissolved' || !!profile.date_of_cessation,
  }
}

async function resolveCompany({ knownNumber, companyName }) {
  const known = (knownNumber ?? '').trim()
  if (known) {
    const r = await buildRundown(known, 'company_number')
    return r ? { rundown: r, reason: 'matched_by_number' } : { rundown: null, reason: 'number_not_found' }
  }
  const name = (companyName ?? '').trim()
  if (!name) return { rundown: null, reason: 'no_input' }
  if (normName(name).length < 3) return { rundown: null, reason: 'name_too_generic' }

  const search = await chFetch(`/search/companies?q=${encodeURIComponent(name)}&items_per_page=10`)
  const items = search?.items ?? []
  if (!items.length) return { rundown: null, reason: 'no_search_results' }

  const target = normName(name)
  const exact = items.filter(i => i.company_number && normName(i.title ?? '') === target)
  const active = exact.filter(i => (i.company_status ?? '').toLowerCase() === 'active')

  let pick = null
  if (active.length === 1) pick = active[0]
  else if (active.length === 0 && exact.length === 1) pick = exact[0]

  if (!pick?.company_number) {
    return { rundown: null, reason: exact.length > 1 ? 'ambiguous_name' : 'no_confident_match' }
  }
  const r = await buildRundown(pick.company_number, 'name_search')
  return r ? { rundown: r, reason: 'matched_by_name' } : { rundown: null, reason: 'profile_fetch_failed' }
}

function rundownToRawFields(r) {
  const out = {}
  const put = (k, v) => { const t = (v ?? '').toString().trim(); if (t) out[k] = t }
  put('ch_company_number', r.company_number)
  put('ch_company_status', r.company_status)
  put('ch_company_type', r.company_type)
  put('ch_incorporated_on', r.incorporated_on)
  put('ch_registered_address', r.registered_address)
  put('ch_companies_house_url', r.companies_house_url)
  put('ch_endole_url', r.endole_url)
  if (r.sic_codes.length) put('ch_sic_codes', r.sic_codes.join(', '))
  put('address_line', r.registered_address)
  return out
}

// ── Main ──────────────────────────────────────────────────────────────────
const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const params = []
let where = `first_replied_at IS NOT NULL
  AND (raw->>'ch_company_status' IS NULL OR raw->>'ch_company_status' = '')
  AND coalesce(btrim(company_name), '') <> ''`
if (WORKSPACE) { params.push(WORKSPACE); where += ` AND workspace_id = $${params.length}` }
let sql = `SELECT id, workspace_id, email, company_name, raw->>'ch_company_number' AS known_number
           FROM esp_leads WHERE ${where} ORDER BY first_replied_at DESC`
if (LIMIT) { params.push(LIMIT); sql += ` LIMIT $${params.length}` }

const { rows } = await client.query(sql, params)
console.log(`Mode: ${COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no writes)'}`)
console.log(`Candidates (replied, missing CH, has company_name)${WORKSPACE ? ` in workspace ${WORKSPACE}` : ''}: ${rows.length}\n`)

const stats = { matched: 0, skipped: 0, byReason: {} }
for (const row of rows) {
  const { rundown, reason } = await resolveCompany({ knownNumber: row.known_number, companyName: row.company_name })
  stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1
  if (rundown) {
    stats.matched++
    const fields = rundownToRawFields(rundown)
    console.log(`✓ ${row.email}  "${row.company_name}" → ${rundown.company_name} [${rundown.company_status}] (${rundown.company_number}) via ${reason}`)
    if (COMMIT) {
      await client.query(
        `UPDATE esp_leads
           SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify({ ...fields, ch_enrich_reason: reason }), row.id, row.workspace_id]
      )
    }
  } else {
    stats.skipped++
    console.log(`· ${row.email}  "${row.company_name}" → no data (${reason})`)
    if (COMMIT) {
      await client.query(
        `UPDATE esp_leads
           SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify({ ch_enrich_reason: reason }), row.id, row.workspace_id]
      )
    }
  }
}

console.log(`\n── Summary ──`)
console.log(`Matched (CH data set): ${stats.matched}`)
console.log(`Skipped (no confident match): ${stats.skipped}`)
console.log(`Reasons:`, stats.byReason)
if (!COMMIT) console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.`)

await client.end()
