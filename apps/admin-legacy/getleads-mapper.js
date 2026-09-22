// GetLeads → contacts row mapper.
//
// GetLeads (app.getleads.io) is a LinkedIn-derived contact database reached
// over MCP. Claude runs the search and hands us already-shaped rows, so this
// module only has to translate GetLeads' column labels into the field names
// `bulkCreateContacts` expects.
//
// Two things worth knowing about the source data, both measured 2026-09-22:
//
//   1. Only ~17% of GetLeads rows carry an email (66.5M of 402M). Always
//      search with require_email, or most of what comes back is unsendable.
//   2. Every email it does return is already VALID-verified — filtering
//      email_status=VALID returns the identical count to require_email. So
//      these rows do not need a Reacher pass before their first send.
//
// The push path requires a non-empty `industry` (see the enrichment gate in
// server.js), so `industry` is filled from the LinkedIn company industry and
// falls back to the UK SIC description. A row with neither is still imported
// — it just will not push until something fills that field.

// GetLeads seniority vocabulary is its own: C-Team, VP, Director, Manager,
// Staff, Other. It is NOT Apollo's, so csv-importer's mapSeniority would
// return null for every row. Map onto the contacts table's vocabulary
// (junior|manager|director|vp|c_suite) instead.
const SENIORITY = {
  'c-team': 'c_suite',
  'c team': 'c_suite',
  'cxo': 'c_suite',
  'vp': 'vp',
  'director': 'director',
  'manager': 'manager',
  'staff': 'junior',
};

function mapSeniority(value) {
  if (!value) return null;
  return SENIORITY[String(value).trim().toLowerCase()] || null;
}

// "51 to 200" / "1-10" / "10001+" → integer lower bound, matching
// csv-importer.parseEmployees so the existing `emp=` buckets keep working.
function parseEmployees(value) {
  if (value == null) return null;
  const s = String(value).replace(/,/g, '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+)\s*(?:to|-|–)\s*\d+$/i))) return parseInt(m[1], 10);
  if ((m = s.match(/^(\d+)\s*\+$/)))                return parseInt(m[1], 10);
  if ((m = s.match(/^(\d+)$/)))                     return parseInt(m[1], 10);
  return null;
}

// Strip a URL down to a bare domain so it matches how company_domain is
// stored elsewhere (no scheme, no www, no path).
function cleanDomain(value) {
  if (!value) return null;
  let d = String(value).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  return d || null;
}

const str = v => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Accept either the CSV display label or the internal name for each field,
// so a row works whether it came from an export file or straight from the
// MCP tool's JSON.
function pick(row, ...names) {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  return null;
}

/**
 * Map one GetLeads row to the shape bulkCreateContacts takes.
 * Returns null when the row has no email — email is the table's unique key
 * and the only genuinely required field.
 */
function mapRow(row) {
  const email = pick(row, 'Email', 'email', 'EMAIL_ADDRESS');
  if (!email || !email.includes('@')) return null;

  const jobTitle = pick(row, 'Current Job Title', 'job_title', 'JOB_TITLE');

  // The push gate needs a non-empty industry. LinkedIn's company industry is
  // the richer field (80% fill); UK SIC description is the fallback.
  const industry = pick(row, 'Company Industry (LinkedIn)', 'industry', 'INDUSTRY_LINKEDIN')
                || pick(row, '2007 UK SIC Description', 'INDUSTRY_UK_STANDARD_2007_DESCRIPTION')
                || pick(row, 'SIC Industry Description', 'INDUSTRY_SIC_DESCRIPTION');

  // `keywords` is no longer required to push (it is never sent to PlusVibe),
  // but the copy templates read it, so fill it where GetLeads has something
  // descriptive: company specialties first, then the person's own headline.
  const keywords = pick(row, 'Company Specialties (LinkedIn)', 'SPECIALTIES')
                || pick(row, 'Profile Headline', 'LINKEDIN_HEADLINE');

  return {
    email: email.toLowerCase(),
    firstName: pick(row, 'First Name', 'first_name', 'FIRST_NAME'),
    lastName:  pick(row, 'Last Name', 'last_name', 'LAST_NAME'),
    phone:     pick(row, 'Cellphone', 'Direct Office Phone', 'phone', 'CELLPHONE'),

    companyName:   pick(row, 'Company Name', 'company_name', 'COMPANY_NAME'),
    companyDomain: cleanDomain(pick(row, 'Company Domain', 'Company Website', 'company_domain', 'DOMAIN')),

    jobTitle,
    // Leave jobTitleCleaned null — the caller runs csv-importer's
    // normalizeJobTitle, which is the one shared implementation.
    jobTitleCleaned: null,
    seniority:  mapSeniority(pick(row, 'Seniority Level', 'seniority', 'SENIORITY')),
    department: pick(row, 'Department / Function', 'department', 'JOB_FUNCTION'),

    city:    pick(row, 'Contact City', 'city', 'CITY'),
    state:   pick(row, 'Contact State', 'state', 'STATE'),
    country: pick(row, 'Contact Country', 'country', 'COUNTRY_NAME'),

    companyCity:    pick(row, 'Company City', 'HQ City', 'COMPANY_CITY'),
    companyState:   pick(row, 'Company State', 'HQ State'),
    companyCountry: pick(row, 'Company Country', 'HQ Country', 'COMPANY_COUNTRY'),
    companyAddress: pick(row, 'Company Street Address', 'HQ Street Address'),

    linkedinUrl:        pick(row, 'Contact LinkedIn URL', 'linkedin_url', 'LINKEDIN_URL'),
    companyLinkedinUrl: pick(row, 'Company LinkedIn URL', 'LINKEDIN_URL_ORG'),

    industry,
    keywords,
    numEmployees: parseEmployees(pick(row, 'Employee Count Range', 'Min Employee Count', 'EMPLOYEE_COUNT_RANGE')),

    source: 'getleads',
    // Keep the whole original row. Apollo rows do the same, and it is what
    // makes a later re-map possible without re-pulling (and re-paying).
    rawData: row,
  };
}

/**
 * Map a batch, dropping rows with no email and reporting how many went.
 * Deduping is left to bulkCreateContacts, which already handles it.
 */
function mapRows(rows) {
  const mapped = [];
  let skippedNoEmail = 0;
  for (const r of rows) {
    const m = mapRow(r);
    if (m) mapped.push(m); else skippedNoEmail++;
  }
  return { mapped, skippedNoEmail };
}

module.exports = { mapRow, mapRows, mapSeniority, parseEmployees, cleanDomain };
