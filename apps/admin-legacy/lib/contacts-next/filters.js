// One filter parser for the whole contacts v2 surface.
//
// The original page grew five hand-copied whitelists (search, facet counts,
// export, sendability, push refill) and they drifted: the list dropped
// hasName/hasCompany that the sendable badge honoured, the export dropped
// priorityTiers that the list honoured, and the per-client master exclusions
// were merged into the list only. The same filter therefore meant a different
// set of contacts depending on which button was pressed.
//
// Everything in v2 goes through parseFilters() + applyClientRules(), then into
// PostgresDatabase._buildFilterClauses(). List, counts, facets, export and the
// filter object handed to the push are all the SAME object.

// Every key _buildFilterClauses understands. A key that is not listed here is
// dropped, so a typo in the UI fails loudly in review rather than silently
// widening a search.
const FILTER_KEYS = Object.freeze([
  // text search
  'search',
  // who
  'status', 'seniority', 'firstName', 'lastName',
  'jobTitle', 'jobTitleExclude', 'department', 'departmentIs', 'subDepartments',
  'email', 'phone', 'linkedinUrl', 'hasName', 'hasLinkedin', 'hasPhone',
  // company
  'company', 'hasCompany', 'website', 'companyLinkedin',
  'industry', 'industryExclude', 'industryIs', 'industryIsNot',
  'keywords', 'keywordsExclude', 'technologies', 'technologiesExclude',
  'sicCodes', 'numEmployeesRanges', 'numEmployeesExcludeRanges',
  'companyAgeBand', 'chVerified', 'chStatus', 'chInsolvency', 'chCharges', 'chOverdue', 'chOnlyEnriched',
  'ownsBuilding', 'ccodOwnsBuilding',
  'solarStatus', 'solarStatusExclude', 'solarMinKwp',
  'adsRunsAds', 'adsMinCount', 'adsMaxCount',
  // where
  'city', 'state', 'country', 'cityExclude', 'stateExclude', 'countryExclude',
  'companyCity', 'companyState', 'companyCountry', 'companyCountryIs',
  'companyCityExclude', 'companyStateExclude', 'companyCountryExclude',
  'companyRegion', 'companyCounty', 'companyTown',
  'companyRegionExclude', 'companyCountyExclude', 'companyTownExclude',
  'personRegion', 'personCounty', 'personTown',
  'personRegionExclude', 'personCountyExclude', 'personTownExclude',
  'locationNeedsReview', 'worksRemote', 'excludeRemote',
  // data quality
  'source', 'tags', 'emailStatus', 'emailProviders', 'excludeMicrosoft',
  'gateway', 'gatewayExclude', 'tier', 'hideDead', 'excludeDNC',
  'verifiedWithinDays', 'verifiedOlderThanDays',
  'updatedAge', 'freshnessDays', 'staleDays', 'importedWithinDays', 'priorityTiers',
  // history
  'sentToPV', 'notSentToPV', 'neverEmailed', 'restedDays', 'notEmailedDays',
  'sentToClient', 'notSentToClient', 'everLead',
  'notExportedToApollo', 'exportedToApollo',
  'hasFact', 'excludeFact',
  // client scope (set by applyClientRules, also accepted from a saved filter)
  'vertical', 'cooldownWorkspace',
]);
const FILTER_KEY_SET = new Set(FILTER_KEYS);

// Keys the client rules own. A caller may not smuggle these in: they are
// derived from the selected client, never typed.
const SERVER_ONLY = new Set(['excludeNonOwnerDomain', 'disqualifierOverrides']);

function clean(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).join(',');
  if (typeof v === 'boolean') return v ? 'true' : '';
  return String(v).trim();
}

// src: req.query or a JSON body. Returns a plain object holding only known,
// non-empty filter keys, every value a string. `q` is accepted as an alias for
// `search` because saved campaign filters from the original page use it.
function parseFilters(src = {}) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(src)) {
    const k = key === 'q' ? 'search' : key;
    if (!FILTER_KEY_SET.has(k) || SERVER_ONLY.has(k)) continue;
    const v = clean(src[key]);
    if (v !== '') out[k] = v;
  }
  return out;
}

const mergeCsv = (a, b) => {
  const aa = String(a || '').split(',').map(s => s.trim()).filter(Boolean);
  const bb = String(b || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...aa, ...bb])].join(',');
};

// Read one client's rule row (SQLite client_verticals). null when the client
// has no row or SQLite is unavailable.
function loadClientRules(sq, clientWorkspaceId) {
  if (!sq || !clientWorkspaceId) return null;
  try {
    return sq.prepare(`SELECT * FROM client_verticals WHERE workspace_id = ?`).get(String(clientWorkspaceId)) || null;
  } catch (e) {
    console.warn('[contacts-next] client rules lookup failed:', e.message);
    return null;
  }
}

// Fold the selected client's always-on rules into a filter object.
//
// This is the logic that used to live inline in GET /api/contacts/search and
// nowhere else. It is behaviour-for-behaviour the same merge (excluded
// industries / keywords / job titles / cities / counties / sizes, the
// building-ownership hard block, the forced vertical, the live disqualifier
// overrides, the per-client cooldown), lifted out so EVERY v2 path applies it.
//
// Returns { filters, rules } where `rules` is a plain summary the UI shows as
// locked chips, so nothing the client record does is invisible.
function applyClientRules(filters, sq, clientWorkspaceId) {
  const f = { ...filters };
  const rules = [];
  if (!clientWorkspaceId) return { filters: f, rules, client: null };
  const ws = String(clientWorkspaceId);

  // Cooldown: hide contacts this client mailed inside the same-client window.
  f.cooldownWorkspace = ws;
  rules.push({ key: 'cooldown', label: 'Not emailed by this client in the last 30 days' });
  // Picking a client always hides do-not-contact, as the original page did.
  f.excludeDNC = 'true';

  const row = loadClientRules(sq, ws);
  if (row) {
    const add = (field, target, label) => {
      const val = String(row[field] || '').trim();
      if (!val) return;
      f[target] = mergeCsv(f[target], val);
      const n = val.split(',').map(s => s.trim()).filter(Boolean).length;
      rules.push({ key: field, label: `${label}: ${n} excluded`, detail: val });
    };
    add('excluded_industries',    'industryExclude',           'Industries');
    add('excluded_keywords',      'keywordsExclude',           'Keywords');
    add('excluded_job_titles',    'jobTitleExclude',           'Job titles');
    add('excluded_cities',        'cityExclude',               'Cities');
    add('excluded_counties',      'stateExclude',              'Counties');
    add('excluded_company_sizes', 'numEmployeesExcludeRanges', 'Company sizes');

    if (Number(row.require_owns_building)) {
      // Two halves, both from the original page: only Land Registry-confirmed
      // owners are shown (ccodOwnsBuilding), and a company that TOLD us it
      // rents is hard-blocked (excludeNonOwnerDomain).
      if (!f.ccodOwnsBuilding) f.ccodOwnsBuilding = 'yes';
      f.excludeNonOwnerDomain = true;
      rules.push({ key: 'owns_building', label: 'Building owners only' });
    }
    // These two are enforced by the push guard, which needs data the filter
    // builder cannot see (other clients' send dates, incorporation date). They
    // are listed so they are not a surprise; the "ready to send" count already
    // reflects them because it runs the real guard.
    if (Number(row.fresh_days) > 0) {
      rules.push({ key: 'fresh_days', atPush: true, label: `Not emailed by another client in ${Number(row.fresh_days)} days` });
    }
    if (Number(row.min_company_age_years) > 0) {
      rules.push({ key: 'min_company_age', atPush: true, label: `Company at least ${Number(row.min_company_age_years)} years old` });
    }
    if (Number(row.exclude_remote)) {
      f.excludeRemote = 'true';
      rules.push({ key: 'exclude_remote', label: 'Skips remote workers' });
    }
    if (row.vertical && !f.vertical) f.vertical = String(row.vertical);
    if (f.vertical) rules.push({ key: 'vertical', label: `Vertical: ${f.vertical} (snoozes and reply facts apply)` });

    try {
      const settingRows = sq.prepare(`SELECT rule_key, snooze_months, enabled FROM disqualifier_rule_settings`).all();
      if (settingRows.length) {
        f.disqualifierOverrides = {};
        for (const sr of settingRows) {
          f.disqualifierOverrides[sr.rule_key] = { snoozeMonths: sr.snooze_months, enabled: !!sr.enabled };
        }
      }
    } catch { /* table may not exist on a fresh DB; defaults apply */ }
  }
  return {
    filters: f,
    rules,
    client: row ? {
      workspace_id: ws,
      workspace_name: row.workspace_name || '',
      vertical: row.vertical || '',
      fresh_days: Number(row.fresh_days) || 0,
      min_company_age_years: Number(row.min_company_age_years) || 0,
    } : { workspace_id: ws, workspace_name: '', vertical: '', fresh_days: 0, min_company_age_years: 0 },
  };
}

// A stable string for cache keys: same filters in any key order hash the same.
function filterSignature(filters) {
  return JSON.stringify(Object.keys(filters).sort().map(k => [k, filters[k]]));
}

module.exports = { FILTER_KEYS, parseFilters, applyClientRules, loadClientRules, filterSignature, mergeCsv };
