// Unit tests for the contacts v2 filter layer. No database needed:
//   node --test test/
//
// They pin the two things that went wrong on the original page: filters that
// silently did nothing, and the same filter meaning different contacts on
// different code paths.

const test = require('node:test');
const assert = require('node:assert/strict');

const PostgresDatabase = require('../db-postgres');
const { parseFilters, applyClientRules, filterSignature, FILTER_KEYS } = require('../lib/contacts-next/filters');

// _buildFilterClauses only needs `this._hasAdsColumns`; no pool is touched.
const db = Object.create(PostgresDatabase.prototype);
db._hasAdsColumns = true;
const build = (f) => db._buildFilterClauses(f);

// Every $n placeholder must have a parameter, and every parameter a
// placeholder. $1 is the tenant, supplied by the caller.
function assertParamsLineUp(f) {
  const { clauses, params } = build(f);
  const sql = clauses.join(' AND ');
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(!used.has(1), 'filter clauses must not use $1 (the tenant)');
  for (let i = 2; i < params.length + 2; i++) assert.ok(used.has(i), `param $${i} is never used in: ${sql}`);
  for (const n of used) assert.ok(n >= 2 && n < params.length + 2, `placeholder $${n} has no parameter in: ${sql}`);
  return { sql, params };
}

// A fake better-sqlite3 handle holding one client_verticals row.
function fakeSqlite(row, settings = []) {
  return {
    prepare(sql) {
      if (/client_verticals/.test(sql)) return { get: () => row };
      if (/disqualifier_rule_settings/.test(sql)) return { all: () => settings };
      throw new Error('unexpected sql: ' + sql);
    },
  };
}

test('parseFilters keeps known keys, drops unknown and empty ones', () => {
  const f = parseFilters({ seniority: 'director', bogus: 'x', company: '   ', hideDead: true, limit: '50', sort: 'best' });
  assert.deepEqual(f, { seniority: 'director', hideDead: 'true' });
});

test('parseFilters joins arrays and accepts q as search', () => {
  assert.deepEqual(parseFilters({ q: 'plumber', seniority: ['director', ' c_suite '] }), { search: 'plumber', seniority: 'director,c_suite' });
});

test('parseFilters refuses server-only keys', () => {
  const f = parseFilters({ excludeNonOwnerDomain: 'true', disqualifierOverrides: { a: 1 } });
  assert.deepEqual(f, {});
});

test('every listed filter key produces a clause, so no filter silently does nothing', () => {
  const sample = {
    search: 'acme', status: 'new', seniority: 'director', firstName: 'a', lastName: 'b', jobTitle: 'owner',
    jobTitleExclude: 'intern', department: 'sales', departmentIs: 'sales', subDepartments: 'x', email: 'a@b', phone: '0113',
    linkedinUrl: 'linkedin', hasName: 'yes', hasLinkedin: 'yes', hasPhone: 'yes', company: 'acme', hasCompany: 'yes',
    website: 'acme.co.uk', companyLinkedin: 'acme', industry: 'construction', industryExclude: 'charity',
    industryIs: 'construction', industryIsNot: 'retail', keywords: 'roofing', keywordsExclude: 'saas',
    technologies: 'hubspot', technologiesExclude: 'wix', sicCodes: '43', numEmployeesRanges: '1-10,11-50',
    numEmployeesExcludeRanges: '5001+', companyAgeBand: 'legacy (25y+)', chVerified: 'yes', chStatus: 'active',
    chInsolvency: 'true', chCharges: 'true', chOverdue: 'true', chOnlyEnriched: 'true', ownsBuilding: 'yes',
    ccodOwnsBuilding: 'yes', solarStatus: 'prospect', solarStatusExclude: 'tenant', solarMinKwp: '100',
    adsRunsAds: 'yes', adsMinCount: '1', adsMaxCount: '9', city: 'leeds', state: 'yorkshire', country: 'united kingdom',
    cityExclude: 'london', stateExclude: 'kent', countryExclude: 'france', companyCity: 'leeds', companyState: 'x',
    companyCountry: 'united kingdom', companyCountryIs: 'united kingdom', companyCityExclude: 'london',
    companyStateExclude: 'x', companyCountryExclude: 'x', companyRegion: 'london', companyCounty: 'kent',
    companyTown: 'leeds', companyRegionExclude: 'wales', companyCountyExclude: 'kent', companyTownExclude: 'hull',
    personRegion: 'london', personCounty: 'kent', personTown: 'leeds', personRegionExclude: 'wales',
    personCountyExclude: 'kent', personTownExclude: 'hull', locationNeedsReview: 'true', worksRemote: 'true',
    excludeRemote: 'true', source: 'getleads', tags: 'batch1', emailStatus: 'safe,not_verified',
    emailProviders: 'email_google,unknown', excludeMicrosoft: 'true', gateway: 'Mimecast', gatewayExclude: 'Proofpoint',
    tier: 'A,B', hideDead: 'true', excludeDNC: 'true', verifiedWithinDays: '3', verifiedOlderThanDays: '30',
    updatedAge: '30', freshnessDays: '60', staleDays: '30', importedWithinDays: '45', priorityTiers: 'P1',
    sentToPV: 'true', notSentToPV: 'true', neverEmailed: 'true', restedDays: '90', notEmailedDays: '14',
    sentToClient: 'ws1', notSentToClient: 'ws2', everLead: 'no', notExportedToApollo: 'true', exportedToApollo: 'true',
    hasFact: 'has_supplier', excludeFact: 'person_left', vertical: 'solar', cooldownWorkspace: 'ws1',
  };
  for (const key of FILTER_KEYS) {
    assert.ok(key in sample, `test sample is missing a value for filter key "${key}"`);
    const { clauses } = build({ [key]: sample[key] });
    assert.ok(clauses.length >= 1, `filter "${key}" produced no SQL clause`);
    assertParamsLineUp({ [key]: sample[key] });
  }
  assertParamsLineUp(sample);
});

test('sicCodes with no digits is ignored instead of matching every company', () => {
  assert.equal(build({ sicCodes: 'care homes' }).clauses.length, 0);
  const { params } = build({ sicCodes: 'care, 87300, 43' });
  assert.equal(params[0], '(^|,)(87300|43)[0-9]*(,|$)');
});

test('new numeric filters reject junk rather than widening the search', () => {
  for (const key of ['verifiedWithinDays', 'verifiedOlderThanDays', 'restedDays', 'notEmailedDays', 'importedWithinDays']) {
    assert.equal(build({ [key]: 'abc' }).clauses.length, 0, key);
    assert.equal(build({ [key]: '-5' }).clauses.length, 0, key);
    assert.equal(build({ [key]: '0' }).clauses.length, 0, key);
    assert.equal(build({ [key]: '30' }).params[0], 30, key);
  }
});

test('tier accepts only A, B, C, X', () => {
  assert.equal(build({ tier: 'Z' }).clauses.length, 0);
  assert.deepEqual(build({ tier: 'a, c ,nope' }).params[0], ['A', 'C']);
});

test('filter values are always bound, never spliced into the SQL', () => {
  const evil = "x'); DROP TABLE contacts;--";
  for (const key of ['industryIs', 'companyCountryIs', 'sentToClient', 'notSentToClient', 'departmentIs', 'tier']) {
    const { clauses } = build({ [key]: evil });
    assert.ok(!clauses.join(' ').includes('DROP TABLE'), `${key} leaked its value into SQL`);
  }
});

test('applyClientRules without a client changes nothing', () => {
  const { filters, rules, client } = applyClientRules({ seniority: 'director' }, fakeSqlite(null), '');
  assert.deepEqual(filters, { seniority: 'director' });
  assert.deepEqual(rules, []);
  assert.equal(client, null);
});

test('applyClientRules folds the client record into the filter', () => {
  const row = {
    workspace_id: 'ws1', workspace_name: 'Acme', vertical: 'solar', exclude_remote: 1, require_owns_building: 1,
    excluded_industries: 'charity, education', excluded_company_sizes: '5001+', excluded_keywords: '',
    excluded_counties: 'kent', excluded_cities: '', excluded_job_titles: 'intern', fresh_days: 45, min_company_age_years: 3,
  };
  const { filters, rules, client } = applyClientRules(
    { industryExclude: 'retail', seniority: 'director' },
    fakeSqlite(row, [{ rule_key: 'has_supplier:solar', snooze_months: 3, enabled: 1 }]),
    'ws1');
  assert.equal(filters.cooldownWorkspace, 'ws1');
  assert.equal(filters.excludeDNC, 'true');
  assert.equal(filters.industryExclude, 'retail,charity,education'); // typed excludes are kept, client's are added
  assert.equal(filters.numEmployeesExcludeRanges, '5001+');
  assert.equal(filters.stateExclude, 'kent');
  assert.equal(filters.jobTitleExclude, 'intern');
  assert.equal(filters.ccodOwnsBuilding, 'yes');
  assert.equal(filters.excludeNonOwnerDomain, true);
  assert.equal(filters.excludeRemote, 'true');
  assert.equal(filters.vertical, 'solar');
  assert.deepEqual(filters.disqualifierOverrides, { 'has_supplier:solar': { snoozeMonths: 3, enabled: true } });
  assert.equal(filters.seniority, 'director');
  assert.equal(client.workspace_name, 'Acme');
  const keys = rules.map((r) => r.key);
  for (const k of ['cooldown', 'excluded_industries', 'excluded_company_sizes', 'excluded_counties', 'excluded_job_titles', 'owns_building', 'exclude_remote', 'vertical', 'fresh_days', 'min_company_age']) {
    assert.ok(keys.includes(k), `rule chip "${k}" is missing`);
  }
  assert.ok(rules.find((r) => r.key === 'fresh_days').atPush);
  // The resolved object must still build valid SQL: it is what the list, the
  // export and the push refill all run.
  assertParamsLineUp(filters);
});

test('applyClientRules never mutates the caller\'s filters', () => {
  const typed = { industryExclude: 'retail' };
  applyClientRules(typed, fakeSqlite({ workspace_id: 'ws1', excluded_industries: 'charity' }), 'ws1');
  assert.deepEqual(typed, { industryExclude: 'retail' });
});

test('a user-set building filter is not overwritten by the client rule', () => {
  const { filters } = applyClientRules({ ccodOwnsBuilding: 'checked' }, fakeSqlite({ workspace_id: 'ws1', require_owns_building: 1 }), 'ws1');
  assert.equal(filters.ccodOwnsBuilding, 'checked');
});

test('filterSignature ignores key order', () => {
  assert.equal(filterSignature({ a: '1', b: '2' }), filterSignature({ b: '2', a: '1' }));
  assert.notEqual(filterSignature({ a: '1' }), filterSignature({ a: '2' }));
});

test('tier SQL names every tier and the alive rule', () => {
  for (const t of ["'A'", "'B'", "'C'", "'X'"]) assert.ok(PostgresDatabase.TIER_SQL.includes(t));
  assert.ok(PostgresDatabase.ALIVE_SQL.includes('do_not_contact'));
});

test('industry values are normalised the same way in JS and in the filter', () => {
  assert.equal(PostgresDatabase.normIndustry('Staffing & Recruiting'), 'staffing and recruiting');
  assert.equal(PostgresDatabase.normIndustry('  Staffing   and Recruiting '), 'staffing and recruiting');
  assert.equal(PostgresDatabase.normIndustry('Food&Beverages'), 'food and beverages');
  const { clauses, params } = build({ industryIs: 'Staffing & Recruiting,Construction' });
  assert.deepEqual(params[0], ['staffing and recruiting', 'construction']);
  assert.ok(clauses[0].includes('regexp_replace'), 'industryIs must compare the normalised column');
});

test('tier A alone adds an index-friendly status condition; other tier sets do not', () => {
  const hint = PostgresDatabase.TIER_A_INDEX_PREDICATE;
  assert.ok(build({ tier: 'A' }).clauses.includes(hint));
  assert.ok(!build({ tier: 'A,B' }).clauses.includes(hint));
  assert.ok(!build({ tier: 'C' }).clauses.includes(hint));
});

test('GetLeads mapper prefers the exact head-count over the range lower bound', () => {
  const { mapRow, exactEmployees } = require('../getleads-mapper');
  const base = { work_email: 'a@acme.co.uk', first_name: 'A', last_name: 'B', company_name: 'Acme' };
  assert.equal(mapRow({ ...base, employee_count_range: '11 to 50', linkedin_employee_count_exact: '37' }).numEmployees, 37);
  assert.equal(mapRow({ ...base, employee_count_range: '11 to 50' }).numEmployees, 11);
  assert.equal(mapRow({ ...base, employee_count_range: '11 to 50', linkedin_employee_count_exact: '0' }).numEmployees, 11);
  assert.equal(mapRow({ ...base, employee_count_range: '11 to 50', linkedin_employee_count_exact: 'n/a' }).numEmployees, 11);
  assert.equal(exactEmployees('1,204'), 1204);
  assert.equal(exactEmployees(''), null);
  assert.equal(exactEmployees('11 to 50'), null);
});

test('upkeep drops only the two indexes proven unused, and never one it builds', () => {
  const m = require('../lib/contacts-next/maintenance');
  assert.deepEqual(m.DROP_INDEXES, ['idx_contacts_keywords_trgm', 'idx_contacts_raw_data_gin']);
  const built = m.BUILD_INDEXES.map((x) => x[0]);
  for (const d of m.DROP_INDEXES) assert.ok(!built.includes(d));
  assert.ok(!m.DROP_INDEXES.includes('idx_contacts_technologies_trgm'), 'the Technologies filter uses this index');
});

test('the tier A index uses the same predicate text as the tier A filter', () => {
  const m = require('../lib/contacts-next/maintenance');
  const idx = m.BUILD_INDEXES.find((x) => x[0] === 'idx_contacts_tier_a');
  assert.ok(idx, 'idx_contacts_tier_a is not in BUILD_INDEXES');
  assert.ok(idx[1].includes(PostgresDatabase.TIER_A_INDEX_PREDICATE));
  // Tier A in TIER_SQL requires both halves of that predicate.
  assert.ok(PostgresDatabase.UNTOUCHED_SQL.includes('last_emailed_at IS NULL'));
});

test('text filters use the form the trigram indexes are built on', () => {
  for (const [key, col] of [['firstName', 'first_name'], ['lastName', 'last_name'], ['email', 'email'], ['website', 'company_domain']]) {
    const { clauses, params } = build({ [key]: 'SmiTH' });
    assert.equal(clauses[0], `LOWER(${col}) LIKE $2`, key);
    assert.equal(params[0], '%smith%', key);
  }
  const c = build({ company: 'ACME' });
  assert.equal(c.clauses[0], '(LOWER(company_name) LIKE $2 OR LOWER(company_domain) LIKE $2)');
  assert.equal(c.params[0], '%acme%');
});

test('search box: indexed UNION form for 3+ characters, single-scan form for shorter', () => {
  const long = build({ search: 'Plumber' });
  assert.ok(long.clauses[0].startsWith('contacts.id IN ('));
  assert.equal((long.clauses[0].match(/UNION ALL/g) || []).length, 4);
  assert.deepEqual(long.params, ['%plumber%']);
  const short = build({ search: 'ab' });
  assert.ok(short.clauses[0].includes('email ILIKE $2'));
  assert.deepEqual(short.params, ['%ab%']);
  assertParamsLineUp({ search: 'plumber', seniority: 'director', company: 'acme' });
});
