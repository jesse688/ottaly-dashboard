// The per-DOMAIN resolver. One CH resolve answers three questions for the whole
// domain: which company, do they own it (PSC), where's the building (postcode →
// CCOD, wired in a later phase). Officer/PSC name match is the authoritative
// signal; name+postcode is the fallback.

import { searchCompanies, getProfile, getOfficers, getPSC, chEnabled } from './ch.js'
import { localSearch, localProfile, localPSC, cachedOfficers, cacheOfficers } from './chlocal.js'
import { bestPersonMatch, parseCHName, personSimilarity } from './names.js'
import { postcodeTier } from './postcode.js'

// Local-DB-first wrappers: hit the bulk-imported ch_companies/ch_directors tables
// first (free, no rate limit), fall to the CH API only on a miss. PSC is API-only
// (not in the bulk data). Track API usage on the returned result for observability.
// Case-insensitive active check (API: 'active'; local bulk: 'Active').
const isActive = (s) => String(s || '').toLowerCase() === 'active'

async function searchFirst(name, n, stats) {
  const local = await localSearch(name, n)
  // Trust local only if it surfaced an ACTIVE candidate — the bulk register can
  // hold just a dissolved namesake while the live company (the one with current
  // officers/PSC) is the API's top hit. If local has no active hit, use the API.
  if (local.some((c) => isActive(c.company_status))) { stats.local_search++; return local }
  stats.api_search++
  const api = await searchCompanies(name, n)
  return api.length ? api : local
}
async function profileFirst(num, stats) {
  const local = await localProfile(num)
  if (local) { stats.local_profile++; return local }
  stats.api_profile++; return getProfile(num)
}
async function officersFirst(num, stats) {
  // Officers drive the AUTHORITATIVE match, so we can't trust admin-legacy's
  // partial ch_directors rows. But we CAN trust rows the service cached itself
  // (complete + fresh). Cache → API → cache-write.
  const cached = await cachedOfficers(num)
  if (cached) { stats.cache_officers++; return cached }
  stats.api_officers++
  const officers = await getOfficers(num)
  cacheOfficers(num, officers).catch(() => {}) // fire-and-forget
  return officers
}
async function pscFirst(num, stats) {
  // PSC bulk snapshot (ch_psc) is the FULL dataset when loaded, so local is
  // authoritative here (unlike officers). Fall to API only when the snapshot
  // isn't loaded or this company isn't in it.
  const local = await localPSC(num)
  if (local) { stats.local_psc++; return local }
  stats.api_psc++
  return getPSC(num)
}

// Diagnostic: for one domain, show the raw contact names, the top candidate's
// officers/PSC, and every pairwise person-similarity score — so we can see
// exactly why an officer match did or didn't fire.
export async function debugDomain(domain, contacts, meta) {
  const companyName = meta?.company_name || contacts[0]?.company_name
  const out = { domain, companyName, contacts: contacts.map((c) => ({ id: c.id, first_name: c.first_name, last_name: c.last_name, seniority: c.seniority })) }
  if (!companyName) return { ...out, note: 'no company name' }
  const candidates = await searchCompanies(companyName, 5)
  out.candidates = candidates.map((c) => ({ number: c.company_number, title: c.title, status: c.company_status }))
  if (!candidates.length) return out
  const top = candidates[0]
  const [officers, psc] = await Promise.all([getOfficers(top.company_number), getPSC(top.company_number)])
  out.top_company = top.company_number
  out.officers = officers.map((o) => o.name)
  out.psc = psc.list.map((p) => p.name)
  out.psc_filedNone = psc.filedNone
  const people = [...officers.map((o) => ({ name: o.name, _kind: 'officer' })), ...psc.list.map((p) => ({ name: p.name, _kind: 'psc' }))]
  out.scores = []
  for (const c of contacts) for (const p of people) {
    out.scores.push({ contact: `${c.first_name || ''} ${c.last_name || ''}`.trim(), ch: p.name, kind: p._kind, score: personSimilarity(c, p.name) })
  }
  out.scores.sort((a, b) => b.score - a.score)
  return out
}

// Confident company-NAME match, for the fallback path. Token-containment: every
// meaningful token of the shorter name appears in the longer.
const LEGAL = new Set(['limited', 'ltd', 'plc', 'llp', 'lp', 'company', 'co', 'holdings', 'group', 'the'])
function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map((t) => t.trim()).filter((t) => t && !LEGAL.has(t))
}
function confidentNameMatch(a, b) {
  const ta = new Set(nameTokens(a)), tb = new Set(nameTokens(b))
  if (!ta.size || !tb.size) return false
  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  let covered = 0
  for (const t of short) if (long.has(t)) covered++
  return covered === short.size && short.size >= 1
}

function profileToIdentity(p) {
  const addr = p?.registered_office_address || {}
  const addrParts = [addr.premises, addr.address_line_1, addr.address_line_2, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean)
  return {
    ch_company_number: p.company_number,
    ch_company_name: p.company_name || null,
    // Case-insensitive: the API returns 'active', but the local ch_companies bulk
    // import stores the CSV's 'Active' (capital A). Lowercasing both fixes the
    // "everything shows not-active" bug (a case mismatch, not stale data — the
    // bulk import is active-only anyway).
    ch_company_status: String(p.company_status || '').toLowerCase() === 'active' ? 'active' : 'not active',
    ch_company_type: p.type || null,
    ch_postcode: addr.postal_code || null,
    ch_address: addrParts.join(', ') || null,
    ch_sic_codes: (p.sic_codes || []).join(',') || null,
    ch_date_of_cessation: p.date_of_cessation || null,
  }
}

// contacts: senior decision-makers [{id, first_name, last_name, ...}]
// meta: { company_name, company_address } for search + postcode.
export async function resolveDomain(domain, contacts, meta) {
  if (!chEnabled()) return { domain, match_method: 'none', match_confidence: 'none', refresh_error: 'no_ch_key' }
  const companyName = meta?.company_name || contacts[0]?.company_name
  const address = meta?.company_address || contacts.find((c) => c.company_address)?.company_address || ''
  const base = {
    domain,
    senior_contact_ids: contacts.map((c) => c.id),
    match_method: 'none', match_confidence: 'none',
    business_owner: 'unknown', business_owner_basis: null,
    building_owner: null, building_owner_name: null, building_site_count: null,
  }
  if (!companyName) return { ...base, refresh_error: 'no_company_name' }

  const stats = { local_search: 0, api_search: 0, local_profile: 0, api_profile: 0, cache_officers: 0, api_officers: 0, local_psc: 0, api_psc: 0 }
  const candidates = await searchFirst(companyName, 5, stats)
  if (!candidates.length) return { ...base, ch_source_stats: stats }

  // Score EVERY candidate: fetch its profile/officers/PSC, look for a person
  // match, and score how well the company name+postcode fit. We pick the best
  // company by (person-match > confident name+postcode > any name match), then
  // ALWAYS derive ownership from that company's PSC — decoupled from whether OUR
  // contact happens to be a director. Ownership is a property of the company.
  const ordered = [...candidates].sort((a, b) => isActive(b.company_status) - isActive(a.company_status))
  const scored = []
  for (const cand of ordered) {
    const [profile, officers, psc] = await Promise.all([
      profileFirst(cand.company_number, stats),
      officersFirst(cand.company_number, stats),
      pscFirst(cand.company_number, stats), // local ch_psc snapshot first, API on miss
    ])
    if (!profile) continue
    const identity = profileToIdentity(profile)
    // The local ch_companies bulk import's company_status is stale/unreliable
    // (shows most companies "not active"). The CH SEARCH result carries a fresh,
    // correct status — prefer it. Only fall back to the profile's when the search
    // candidate didn't provide one.
    if (cand.company_status) {
      identity.ch_company_status = isActive(cand.company_status) ? 'active' : 'not active'
    }
    const people = [
      ...officers.map((o) => ({ name: o.name, _kind: 'officer' })),
      ...psc.list.map((p) => ({ name: p.name, _kind: 'psc' })),
    ]
    const match = bestPersonMatch(contacts, people)
    const nameOk = confidentNameMatch(companyName, profile.company_name)
    const tier = postcodeTier(address, identity.ch_postcode)
    // rank: person-match (3) > confident name + postcode agree (2) > confident name (1) > weak (0)
    let rank = 0
    if (match) rank = 3
    else if (nameOk && tier !== 'none') rank = 2
    else if (nameOk) rank = 1
    scored.push({ identity, officers, psc, match, nameOk, tier, rank })
    // A person match on an active company is the best we can do — take it early.
    if (match && identity.ch_company_status === 'active') break
  }
  if (!scored.length) return { ...base, ch_source_stats: stats }

  // Best company: highest rank, prefer active, then postcode agreement.
  scored.sort((a, b) => b.rank - a.rank
    || (b.identity.ch_company_status === 'active') - (a.identity.ch_company_status === 'active')
    || (b.tier === 'confident') - (a.tier === 'confident'))
  const best = scored[0]
  if (best.rank === 0) return { ...base, ch_source_stats: stats } // nothing we're confident about

  // ── Ownership from the chosen company's PSC (independent of contact match) ──
  const psc = best.psc
  const pscNames = psc.list.map((p) => p.name)
  let business_owner, business_owner_basis
  if (best.match && best.match.kind === 'psc') {
    // Our contact IS a >25% owner — the strongest possible ownership signal.
    business_owner = 'yes'; business_owner_basis = 'contact_is_psc'
  } else if (psc.list.length) {
    // The company HAS identified owners (PSC). If our contact matched an officer
    // but isn't on the PSC list, they're a director-not-owner. Either way we now
    // KNOW who the owners are — surface them.
    business_owner = best.match ? 'no' : 'unknown'
    business_owner_basis = best.match ? 'contact_not_psc' : 'psc_known_not_matched'
  } else if (psc.filedNone) {
    business_owner = 'unknown'; business_owner_basis = 'no_psc_filed'
  } else {
    business_owner = 'unknown'; business_owner_basis = 'no_psc_data'
  }

  // Confidence + method reflect HOW we picked the company.
  const method = best.match ? best.match.kind : (best.rank >= 2 ? 'name_postcode' : 'name')
  const confidence = best.match
    ? (best.tier === 'confident' ? 'confident' : 'medium')
    : (best.rank === 2 ? (best.tier === 'confident' ? 'medium' : 'medium') : 'low')

  return {
    ...base, ...best.identity,
    match_method: method, match_confidence: confidence,
    anchor_contact_id: best.match ? best.match.contact.id : null,
    anchor_officer_name: best.match ? best.match.person.name : null,
    officers_snapshot: best.officers, psc_snapshot: psc.list,
    business_owner, business_owner_basis,
    psc_owners: pscNames, // the identified >25% owners of the company
    ch_source_stats: stats,
  }
}
