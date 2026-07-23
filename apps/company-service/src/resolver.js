// The per-DOMAIN resolver. One CH resolve answers three questions for the whole
// domain: which company, do they own it (PSC), where's the building (postcode →
// CCOD, wired in a later phase). Officer/PSC name match is the authoritative
// signal; name+postcode is the fallback.

import { searchCompanies, getProfile, getOfficers, getPSC, chEnabled } from './ch.js'
import { bestPersonMatch, parseCHName } from './names.js'
import { postcodeTier } from './postcode.js'

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
    ch_company_status: p.company_status === 'active' ? 'active' : 'not active',
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

  const candidates = await searchCompanies(companyName, 5)
  if (!candidates.length) return { ...base }

  // Probe candidates (active first) for an officer/PSC name match.
  const ordered = [...candidates].sort((a, b) => (b.company_status === 'active') - (a.company_status === 'active'))
  let fallback = null // best name+postcode candidate if no person match

  for (const cand of ordered) {
    const [profile, officers, psc] = await Promise.all([
      getProfile(cand.company_number),
      getOfficers(cand.company_number),
      getPSC(cand.company_number),
    ])
    if (!profile) continue
    const identity = profileToIdentity(profile)

    // Build the person pool: officers + PSC (each tagged with its kind).
    const people = [
      ...officers.map((o) => ({ name: o.name, _kind: 'officer' })),
      ...psc.list.map((p) => ({ name: p.name, _kind: 'psc' })),
    ]
    const match = bestPersonMatch(contacts, people)

    if (match) {
      const tier = postcodeTier(address, identity.ch_postcode)
      // Officer/PSC match is strong on its own; postcode only adjusts confidence,
      // it does NOT clear (unlike the per-contact name job).
      const confidence = tier === 'confident' ? 'confident' : tier === 'medium' ? 'medium' : 'medium'
      // Business ownership: did the anchor match a PSC (>25% control)?
      const isPSC = match.kind === 'psc'
      let business_owner, business_owner_basis
      if (isPSC) { business_owner = 'yes'; business_owner_basis = 'psc' }
      else if (psc.filedNone) { business_owner = 'unknown'; business_owner_basis = 'no_psc_filed' }
      else if (psc.list.length) { business_owner = 'no'; business_owner_basis = 'not_psc' }
      else { business_owner = 'unknown'; business_owner_basis = 'no_psc_filed' }

      return {
        ...base, ...identity,
        match_method: match.kind, match_confidence: confidence,
        anchor_contact_id: match.contact.id,
        anchor_officer_name: match.person.name,
        officers_snapshot: officers, psc_snapshot: psc.list,
        business_owner, business_owner_basis,
      }
    }

    // No person match on this candidate — remember it if the company name is a
    // confident match + postcode agrees, as a fallback.
    if (!fallback && confidentNameMatch(companyName, profile.company_name)) {
      const tier = postcodeTier(address, identity.ch_postcode)
      if (tier !== 'none' && identity.ch_company_status === 'active') {
        fallback = { ...base, ...identity, match_method: 'name_postcode', match_confidence: 'low',
          officers_snapshot: officers, psc_snapshot: psc.list,
          business_owner: psc.filedNone ? 'unknown' : 'unknown', business_owner_basis: 'no_psc_filed' }
      }
    }
  }

  return fallback || base
}
