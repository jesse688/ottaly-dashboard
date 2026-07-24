// Building-ownership resolution against the local ch_ccod table (HM Land Registry
// CCOD). Given a company's registered postcode + name + reg number, decide whether
// that company is the registered proprietor of property at the postcode.
// Ported from admin-legacy lib/solar/company-match.js + ccod.js.

import { pool } from './db.js'

// --- company-name / reg normalisation (from company-match.js) ---
function normRegNo(reg) {
  const s = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return ''
  const m = s.match(/^([A-Z]{0,2})(\d+)$/)
  if (!m) return s
  const [, prefix, digits] = m
  return prefix + digits.padStart(8 - prefix.length, '0')
}
const SUFFIXES = ['limited', 'ltd', 'plc', 'public limited company', 'llp', 'lp', 'company', 'co', 'incorporated', 'inc', 'holdings', 'group']
function normName(name) {
  let s = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[.,'`()]/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  let changed = true
  while (changed) { changed = false; for (const suf of SUFFIXES) { if (s.endsWith(' ' + suf)) { s = s.slice(0, -(suf.length + 1)).trim(); changed = true } } }
  return s
}
const WEAK = new Set(['uk', 'gb', 'london', 'england', 'international', 'global', 'services', 'trading'])
function nameSimilarity(a, b) {
  const na = normName(a), nb = normName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = na.split(' ').filter(Boolean), tb = nb.split(' ').filter(Boolean)
  const sa = new Set(ta), sb = new Set(tb)
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++
  const union = new Set([...sa, ...sb]).size
  const jaccard = union ? inter / union : 0
  const [short, long] = sa.size <= sb.size ? [sa, sb] : [sb, sa]
  let covered = 0; for (const t of short) if (long.has(t)) covered++
  const containment = short.size ? covered / short.size : 0
  const leftover = [...long].filter((t) => !short.has(t))
  const leftoverAllWeak = leftover.every((t) => WEAK.has(t) || /^\d+$/.test(t))
  if (containment === 1 && short.size >= 2 && leftoverAllWeak) return 0.92
  if (containment === 1 && short.size >= 2) return Math.max(jaccard, 0.8)
  return jaccard
}

// Compare a lead company to one CCOD owner record → verdict for that pair.
function compareOne(lead, owner) {
  const leadReg = normRegNo(lead.reg), ownReg = normRegNo(owner.company_reg_no)
  if (leadReg && ownReg && leadReg === ownReg) return { verdict: 'yes', basis: 'reg_number', score: 1 }
  const sim = nameSimilarity(lead.name, owner.proprietor_name)
  if (sim >= 0.85) return { verdict: 'yes', basis: 'name_strong', score: sim }
  if (sim >= 0.5) return { verdict: 'unclear', basis: 'name_partial', score: sim }
  if (leadReg && ownReg && leadReg !== ownReg) return { verdict: 'no', basis: 'reg_differ', score: sim }
  return { verdict: 'no', basis: 'name_mismatch', score: sim }
}

// Best verdict across all owners at the postcode. A single 'yes' wins.
function resolveOwnership(lead, owners) {
  if (!lead || (!lead.name && !lead.reg)) return { owns_building: 'unclear', matched_owner: null, basis: 'no_lead' }
  if (!owners || !owners.length) return { owns_building: 'no', matched_owner: null, basis: 'no_owner_at_postcode' }
  let best = { verdict: 'no', score: -1, owner: null, basis: 'name_mismatch' }
  for (const o of owners) {
    const r = compareOne(lead, o)
    if (r.verdict === 'yes') return { owns_building: 'yes', matched_owner: o.proprietor_name, basis: r.basis, site_count: countSites(lead, owners) }
    const rank = (v) => (v === 'unclear' ? 1 : 0)
    if (rank(r.verdict) > rank(best.verdict) || (rank(r.verdict) === rank(best.verdict) && r.score > best.score)) best = { ...r, owner: o.proprietor_name }
  }
  return { owns_building: best.verdict === 'unclear' ? 'unclear' : 'no', matched_owner: best.owner, basis: best.basis }
}
function countSites(lead, owners) {
  // How many distinct titles at this postcode this company owns (rough multi-site hint).
  const leadReg = normRegNo(lead.reg)
  const titles = new Set()
  for (const o of owners) {
    const match = (leadReg && normRegNo(o.company_reg_no) === leadReg) || nameSimilarity(lead.name, o.proprietor_name) >= 0.85
    if (match && o.title_number) titles.add(o.title_number)
  }
  return titles.size || 1
}

// Has CCOD been loaded? cached; re-check every 60s while false (like PSC).
let _ccodLoaded = null, _ccodCheckedAt = 0
export async function ccodLoaded() {
  if (_ccodLoaded === true) return true
  const now = Date.now()
  if (_ccodLoaded === false && now - _ccodCheckedAt < 60000) return false
  _ccodCheckedAt = now
  try {
    const { rows } = await pool.query(`SELECT row_count FROM ch_ccod_meta WHERE id = 1`)
    _ccodLoaded = !!(rows[0] && Number(rows[0].row_count) > 0)
  } catch { _ccodLoaded = false }
  return _ccodLoaded
}

// Main entry: does `company` own property at its registered postcode?
// Returns { building_owner, building_owner_name, building_site_count } or nulls.
export async function resolveBuildingOwnership(company) {
  if (!(await ccodLoaded())) return { building_owner: null, building_owner_name: null, building_site_count: null }
  const pc = String(company.ch_postcode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!pc) return { building_owner: 'no_postcode', building_owner_name: null, building_site_count: null }
  let owners
  try {
    const { rows } = await pool.query(
      `SELECT proprietor_name, company_reg_no, property_address, title_number, tenure
         FROM ch_ccod WHERE postcode = $1 LIMIT 500`, [pc])
    owners = rows
  } catch { return { building_owner: null, building_owner_name: null, building_site_count: null } }
  if (!owners.length) return { building_owner: 'no', building_owner_name: null, building_site_count: null }
  const v = resolveOwnership({ name: company.ch_company_name, reg: company.ch_company_number }, owners)
  return {
    building_owner: v.owns_building,
    building_owner_name: v.matched_owner || null,
    building_site_count: v.site_count || null,
  }
}
