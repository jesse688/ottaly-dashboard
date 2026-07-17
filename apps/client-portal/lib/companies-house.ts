// Companies House enrichment — VERIFIED, 100%-accurate company facts only.
//
// Everything here comes from the official Companies House public API
// (https://developer.company-information.service.gov.uk), which returns exact,
// authoritative register data. We NEVER scrape estimated/3rd-party figures: a
// field is filled only when CH gives it to us, otherwise it stays empty.
// Companies House is the ONLY company-data source surfaced — Endole deep-links
// were disabled (not rendered, not written to client-facing fields).
//
// Matching is NUMBER-FIRST and skip-if-uncertain (see resolveCompany): a wrong
// match would put another company's data on a lead, so we only auto-accept a
// confident single match — anything ambiguous returns null and is flagged for
// manual review rather than guessed.

const API = 'https://api.company-information.service.gov.uk'

function authHeader(): Record<string, string> | null {
  const key = process.env.COMPANIES_HOUSE_API_KEY
  if (!key) return null
  // CH uses HTTP Basic with the API key as the username and an empty password.
  return { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }
}

// ── Rate limiting ──────────────────────────────────────────────────────────
// CH allows 600 requests / 5 min (~2/sec). We serialize calls through a single
// promise chain with a min interval, so concurrent enrichments can't burst past
// the limit. One 429 retry that respects Retry-After.
const MIN_INTERVAL_MS = 420
let lastCall = 0
let chain: Promise<unknown> = Promise.resolve()

async function chFetch<T>(path: string): Promise<T | null> {
  const headers = authHeader()
  if (!headers) return null // no key configured → enrichment is a no-op

  const run = async (): Promise<T | null> => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCall = Date.now()

    const doFetch = async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        return await fetch(`${API}${path}`, { headers, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
    }

    let res = await doFetch()
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '2')
      await new Promise(r => setTimeout(r, Math.max(1, retryAfter) * 1000))
      lastCall = Date.now()
      res = await doFetch()
    }
    if (res.status === 404) return null
    if (!res.ok) {
      console.error(`[companies-house] ${path} → ${res.status}`)
      return null
    }
    return await res.json() as T
  }

  // Serialize: queue this call after the previous one settles.
  const result = chain.then(run, run) as Promise<T | null>
  chain = result.catch(() => {})
  return result
}

// ── CH API response shapes (only the fields we read) ─────────────────────────

interface CHSearchItem {
  company_number?: string
  title?: string
  company_status?: string
  company_type?: string
  address_snippet?: string
}
interface CHSearchResult { items?: CHSearchItem[] }

interface CHAddress {
  premises?: string; address_line_1?: string; address_line_2?: string
  locality?: string; region?: string; postal_code?: string; country?: string
}
interface CHProfile {
  company_number?: string
  company_name?: string
  company_status?: string
  type?: string
  date_of_creation?: string
  date_of_cessation?: string
  sic_codes?: string[]
  jurisdiction?: string
  registered_office_address?: CHAddress
  accounts?: { next_accounts?: { overdue?: boolean }; last_accounts?: { made_up_to?: string } }
  has_insolvency_history?: boolean
  has_charges?: boolean
}

interface CHOfficer {
  name?: string
  officer_role?: string
  appointed_on?: string
  resigned_on?: string
  occupation?: string
  nationality?: string
}
interface CHOfficers { items?: CHOfficer[] }

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompanyRundown {
  company_number: string
  company_name: string | null
  company_status: string | null
  company_type: string | null
  incorporated_on: string | null
  date_of_cessation: string | null
  sic_codes: string[]
  jurisdiction: string | null
  registered_address: string | null
  last_accounts_date: string | null
  // Flags worth knowing before talking to them.
  flags: {
    insolvency_history: boolean
    has_charges: boolean
    accounts_overdue: boolean
    dissolved: boolean
  }
  active_officers: { name: string; role: string; appointed_on: string | null }[]
  // Reference links. companies_house_url is the only one surfaced in the UI;
  // endole_url is retained in the shape but no longer rendered or written to the
  // client-facing raw fields (Endole links were disabled).
  companies_house_url: string
  endole_url: string
  matched_by: 'company_number' | 'name_search'
  fetched_at: string
}

function formatAddress(a?: CHAddress): string | null {
  if (!a) return null
  const parts = [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .map(p => (p ?? '').trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

// Build the full rundown for a known company number. Combines profile + officers.
async function buildRundown(
  companyNumber: string, matchedBy: 'company_number' | 'name_search'
): Promise<CompanyRundown | null> {
  const profile = await chFetch<CHProfile>(`/company/${encodeURIComponent(companyNumber)}`)
  if (!profile || !profile.company_number) return null

  const officers = await chFetch<CHOfficers>(
    `/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=35`
  )
  const active = (officers?.items ?? [])
    .filter(o => !o.resigned_on && o.name)
    .map(o => ({ name: o.name!, role: o.officer_role ?? '', appointed_on: o.appointed_on ?? null }))

  const status = profile.company_status ?? null
  return {
    company_number: profile.company_number,
    company_name: profile.company_name ?? null,
    company_status: status,
    company_type: profile.type ?? null,
    incorporated_on: profile.date_of_creation ?? null,
    date_of_cessation: profile.date_of_cessation ?? null,
    sic_codes: profile.sic_codes ?? [],
    jurisdiction: profile.jurisdiction ?? null,
    registered_address: formatAddress(profile.registered_office_address),
    last_accounts_date: profile.accounts?.last_accounts?.made_up_to ?? null,
    flags: {
      insolvency_history: profile.has_insolvency_history === true,
      has_charges: profile.has_charges === true,
      accounts_overdue: profile.accounts?.next_accounts?.overdue === true,
      dissolved: status === 'dissolved' || !!profile.date_of_cessation,
    },
    active_officers: active,
    companies_house_url: `https://find-and-update.company-information.service.gov.uk/company/${profile.company_number}`,
    endole_url: `https://www.endole.co.uk/company/${profile.company_number}`,
    matched_by: matchedBy,
    fetched_at: new Date().toISOString(),
  }
}

// Normalize a company name for confident comparison: lowercase, drop suffixes,
// punctuation and spaces. "Acme Ltd." and "ACME LIMITED" → "acme".
function normName(s: string): string {
  return s.toLowerCase()
    .replace(/\b(limited|ltd|llp|plc|inc|co|company|holdings|group|uk)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// Resolve a company to a CH number and return its full rundown.
//
// Precedence (designed to stay 100% accurate):
//   1. knownNumber present → fetch directly (certain).
//   2. companyName given → CH name-search; accept ONLY when there's exactly one
//      ACTIVE candidate whose normalized name matches exactly. Anything else
//      (no match, multiple plausible, fuzzy) → null (flag for manual), never a guess.
//
// We deliberately do NOT resolve from an email domain alone — a domain → company
// mapping isn't certain enough for client-facing, billable data.
export async function resolveCompany(input: {
  knownNumber?: string | null
  companyName?: string | null
}): Promise<{ rundown: CompanyRundown | null; reason: string }> {
  if (!authHeader()) return { rundown: null, reason: 'no_api_key' }

  const known = (input.knownNumber ?? '').trim()
  if (known) {
    const rundown = await buildRundown(known, 'company_number')
    return rundown
      ? { rundown, reason: 'matched_by_number' }
      : { rundown: null, reason: 'number_not_found' }
  }

  const name = (input.companyName ?? '').trim()
  if (!name) return { rundown: null, reason: 'no_input' }
  if (normName(name).length < 3) return { rundown: null, reason: 'name_too_generic' }

  const search = await chFetch<CHSearchResult>(
    `/search/companies?q=${encodeURIComponent(name)}&items_per_page=10`
  )
  const items = search?.items ?? []
  if (!items.length) return { rundown: null, reason: 'no_search_results' }

  const target = normName(name)
  const exact = items.filter(i => i.company_number && normName(i.title ?? '') === target)
  // Prefer active companies among exact-name matches.
  const active = exact.filter(i => (i.company_status ?? '').toLowerCase() === 'active')

  let pick: CHSearchItem | null = null
  if (active.length === 1) pick = active[0]
  else if (active.length === 0 && exact.length === 1) pick = exact[0]
  // More than one exact/active match → genuinely ambiguous → don't guess.

  if (!pick?.company_number) {
    return { rundown: null, reason: exact.length > 1 ? 'ambiguous_name' : 'no_confident_match' }
  }

  const rundown = await buildRundown(pick.company_number, 'name_search')
  return rundown
    ? { rundown, reason: 'matched_by_name' }
    : { rundown: null, reason: 'profile_fetch_failed' }
}

// Flatten the rundown into the esp_leads.raw string keys the dashboard reads,
// filling ONLY fields CH gave us (caller merges, never clobbering existing data).
export function rundownToRawFields(r: CompanyRundown): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: string | null | undefined) => { const t = (v ?? '').toString().trim(); if (t) out[k] = t }
  put('ch_company_number', r.company_number)
  put('ch_company_status', r.company_status)
  put('ch_company_type', r.company_type)
  put('ch_incorporated_on', r.incorporated_on)
  put('ch_registered_address', r.registered_address)
  put('ch_companies_house_url', r.companies_house_url)
  // Endole intentionally omitted — Companies House is the only company-data
  // source we surface (Endole deep-links were disabled).
  if (r.sic_codes.length) put('ch_sic_codes', r.sic_codes.join(', '))
  // address_line is what the leads panel already renders — backfill it from the
  // verified registered address when we have one.
  put('address_line', r.registered_address)
  return out
}
