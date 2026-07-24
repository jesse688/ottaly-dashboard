// Local Companies House lookups from the bulk-imported ch_companies / ch_directors
// tables (the full UK register, loaded via admin-legacy scripts/import-ch-bulk.js).
// We hit these FIRST and only fall to the CH API for what's missing — crucially
// PSC, which the bulk data does NOT include. This slashes API calls (the 600/5min
// ceiling) for the search + profile + officers steps.

import { pool } from './db.js'

// Search the local register by name. Returns candidates in the same shape as the
// API's search ({ company_number, title, company_status }). Uses a normalised
// name prefix/ILIKE so "0141 Design" finds "0141 DESIGN LIMITED".
export async function localSearch(name, n = 5) {
  const q = String(name || '').trim()
  if (!q) return []
  // Strip legal suffixes + leading "the" so "The 0141 Design Ltd" → "0141 design".
  const bare = q.replace(/\b(limited|ltd|plc|llp|lp|company|co)\b/gi, '')
    .replace(/^the\s+/i, '').replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!bare) return []
  try {
    // Prefix match first (fast, precise), widen to contains only if needed.
    // LOWER(company_status)='active' — the bulk import stores 'Active' (capital A).
    const { rows } = await pool.query(
      `SELECT company_number, company_name AS title, company_status
         FROM ch_companies
        WHERE company_name ILIKE $1
        ORDER BY (LOWER(company_status) = 'active') DESC, length(company_name)
        LIMIT $2`,
      [bare + '%', n])
    if (rows.length) return rows
    // Fallback: contains-match (slower) when no prefix hit.
    const { rows: rows2 } = await pool.query(
      `SELECT company_number, company_name AS title, company_status
         FROM ch_companies
        WHERE company_name ILIKE $1
        ORDER BY (LOWER(company_status) = 'active') DESC, length(company_name)
        LIMIT $2`,
      ['%' + bare + '%', n])
    return rows2
  } catch { return [] } // table may not exist in some envs — caller falls back to API
}

// Local company profile in the API's profileToIdentity input shape.
export async function localProfile(companyNumber) {
  try {
    const { rows } = await pool.query(
      `SELECT company_number, company_name, company_status, company_type, sic_codes,
              postcode, address_line1, address_line2, post_town, county, country, incorporated_on
         FROM ch_companies WHERE company_number = $1`, [companyNumber])
    const r = rows[0]
    if (!r) return null
    // Reshape to match the API profile fields profileToIdentity() reads.
    return {
      company_number: r.company_number,
      company_name: r.company_name,
      company_status: r.company_status,
      type: r.company_type,
      sic_codes: r.sic_codes ? r.sic_codes.split(',').map((s) => s.trim()).filter(Boolean) : [],
      date_of_creation: r.incorporated_on || null,
      date_of_cessation: null,
      registered_office_address: {
        address_line_1: r.address_line1, address_line_2: r.address_line2,
        locality: r.post_town, region: r.county, postal_code: r.postcode, country: r.country,
      },
      _local: true,
    }
  } catch { return null }
}

// Has the PSC bulk snapshot been loaded? Cached after first check so we don't
// re-query per resolve. If not loaded, local PSC is skipped entirely (→ API).
let _pscLoaded = null
let _pscCheckedAt = 0
export async function pscBulkLoaded() {
  // Cache a TRUE result permanently (data doesn't un-load mid-run). While still
  // false, re-check at most every 60s so a load that happens AFTER boot is picked
  // up automatically — no restart needed.
  if (_pscLoaded === true) return true
  const now = Date.now()
  if (_pscLoaded === false && now - _pscCheckedAt < 60000) return false
  _pscCheckedAt = now
  try {
    const { rows } = await pool.query(`SELECT row_count FROM ch_psc_meta WHERE id = 1`)
    _pscLoaded = !!(rows[0] && Number(rows[0].row_count) > 0)
  } catch { _pscLoaded = false }
  return _pscLoaded
}

// Local PSC for a company, in the API getPSC() output shape { list, filedNone }.
// Returns null when the bulk snapshot isn't loaded (caller falls to API).
// A company present in the snapshot but with only a "…-statement" row (no person)
// → filedNone:true. A company absent from the snapshot → we can't tell locally,
// so return null and let the API decide (absent ≠ "no PSC").
export async function localPSC(companyNumber) {
  if (!(await pscBulkLoaded())) return null
  try {
    const { rows } = await pool.query(
      `SELECT name, kind, ceased_on FROM ch_psc WHERE company_number = $1`, [companyNumber])
    if (!rows.length) return null // not in snapshot → let API confirm
    const active = rows.filter((r) => !r.ceased_on)
    const list = active
      .filter((r) => r.name && !/statement$/.test(r.kind || ''))
      .map((r) => ({ name: r.name, kind: r.kind, ceased: false }))
    const filedNone = !list.length // present in snapshot but no active person PSC
    return { list, filedNone, _local: true }
  } catch { return null }
}

// Officer CACHE. ch_directors is sparse/partial from admin-legacy's on-demand
// fetches, so we can't trust an arbitrary local hit for the authoritative match.
// Instead: the company-service marks companies IT has fully fetched (ch_directors
// carries a fetched_by_svc_at stamp we add), and only trusts the cache for those.
// This lets repeat resolves of the same company skip the officer API call without
// risking partial admin-legacy data.

// Read cached officers ONLY if the company-service fetched them recently.
export async function cachedOfficers(companyNumber, maxAgeDays = 30) {
  try {
    const { rows } = await pool.query(
      `SELECT name, role, appointed_on, address FROM ch_directors
        WHERE company_number = $1 AND resigned_on IS NULL
          AND fetched_by_svc_at IS NOT NULL
          AND fetched_by_svc_at > now() - ($2 || ' days')::interval`,
      [companyNumber, String(maxAgeDays)])
    if (!rows.length) return null
    return rows.map((o) => ({
      name: o.name, role: o.role, appointed_on: o.appointed_on,
      postcode: (typeof o.address === 'object' && o.address) ? o.address.postal_code || null : null,
    }))
  } catch { return null } // column may not exist yet on first boot → treat as miss
}

// Persist API-fetched officers so the next resolve of this company is free.
export async function cacheOfficers(companyNumber, officers) {
  if (!companyNumber) return
  try {
    // Clear our previous cache for this company, then insert the fresh set.
    await pool.query(`DELETE FROM ch_directors WHERE company_number = $1 AND fetched_by_svc_at IS NOT NULL`, [companyNumber])
    for (const o of officers) {
      await pool.query(
        `INSERT INTO ch_directors (company_number, name, role, appointed_on, address, fetched_by_svc_at)
         VALUES ($1,$2,$3,$4,$5::jsonb, now())`,
        [companyNumber, o.name, o.role || null, o.appointed_on || null,
         o.postcode ? JSON.stringify({ postal_code: o.postcode }) : null])
    }
  } catch { /* caching is best-effort — never block a resolve */ }
}
