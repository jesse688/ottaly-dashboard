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
  try {
    // Strip legal suffixes off the query; match on a leading ILIKE so the bulk
    // register's "… LIMITED/LTD" still hits. Prefer active companies.
    const bare = q.replace(/\b(limited|ltd|plc|llp|lp|company|co)\b/gi, '').replace(/\s+/g, ' ').trim()
    const { rows } = await pool.query(
      `SELECT company_number, company_name AS title, company_status
         FROM ch_companies
        WHERE company_name ILIKE $1 OR company_name ILIKE $2
        ORDER BY (company_status = 'active') DESC, length(company_name)
        LIMIT $3`,
      [bare + '%', '%' + bare + '%', n])
    return rows
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

// Active officers from ch_directors, in the API getOfficers() output shape.
export async function localOfficers(companyNumber) {
  try {
    const { rows } = await pool.query(
      `SELECT name, role, appointed_on, address FROM ch_directors
        WHERE company_number = $1 AND resigned_on IS NULL`, [companyNumber])
    if (!rows.length) return null // null = "not in local set" → caller tries API
    return rows.map((o) => ({
      name: o.name, role: o.role, appointed_on: o.appointed_on,
      postcode: o.address?.postal_code || null,
    }))
  } catch { return null }
}
