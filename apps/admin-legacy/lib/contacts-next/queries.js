// Read queries behind the contacts v2 page.
//
// Every function here takes an already-resolved filter object (see filters.js)
// and builds its WHERE through PostgresDatabase._buildFilterClauses, the same
// builder the push refill uses. Nothing in this file writes.
//
// Speed rules this file follows, each from a measured problem on the original
// page (contacts is ~2.4M rows, 4GB heap):
//   1. Never SELECT raw_data / ch_data for a list. They live in TOAST and cost
//      seconds of transfer for columns no grid shows.
//   2. Never ORDER BY blindly. A narrow filter + ORDER BY made Postgres walk an
//      ordering index and discard millions of rows (11.6s vs 1.1s measured).
//      search() first learns whether the filter is narrow or broad, then picks
//      the plan shape that suits it.
//   3. Never COUNT(*) a broad filter exactly. Past COUNT_CAP the page shows an
//      estimate from a table sample instead.

const PostgresDatabase = require('../../db-postgres');
const { filterSignature } = require('./filters');

const COUNT_CAP = Number(process.env.CONTACTS_COUNT_CAP) || 10000;
// Rows a facet / summary sample aims to read on a broad filter.
const SAMPLE_TARGET_ROWS = 200000;
// How long a sorted read of a broad filter may run before the page falls back
// to an unsorted one.
const BROAD_SORT_TIMEOUT_MS = Number(process.env.CONTACTS_BROAD_SORT_MS) || 6000;
// How long the capped count may run. A filter that is selective but cannot use
// an index has to read the whole table to learn it has fewer than COUNT_CAP
// matches; without a limit that held a web connection for up to 45s per
// keystroke.
const COUNT_TIMEOUT_MS = Number(process.env.CONTACTS_COUNT_MS) || 8000;
// Deepest row the list will page to.
const MAX_OFFSET = 100000;
const isTimeout = (e) => /statement timeout|canceling statement/i.test(String(e && e.message));

const TIER = PostgresDatabase.TIER_SQL;
const VERIFIED_DATE = PostgresDatabase.VERIFIED_DATE_SQL;
const NEVER_PUSHED = PostgresDatabase.NEVER_PUSHED_SQL;

// Columns the grid shows. Deliberately no JSONB blobs except the small
// emailed_workspaces map (needed for "sent to this client").
const LIST_COLS = [
  'id', 'email', 'first_name', 'last_name', 'job_title', 'seniority', 'department',
  'company_name', 'company_domain', 'industry', 'num_employees',
  'company_region', 'company_county', 'company_town', 'company_country', 'city', 'country',
  'linkedin_url', 'email_status', 'email_verified_at', 'email_verify_reason', 'mx_provider', 'source',
  'imported_at', 'last_emailed_at', 'email_count', 'last_campaign_name',
  'do_not_contact', 'bounce_type', 'marked_as_lead_at', 'last_reply_at', 'status',
  'emailed_workspaces', 'pushed_campaigns', 'ch_sic_codes',
];
const LIST_SELECT = `${LIST_COLS.filter(c => c !== 'pushed_campaigns').join(', ')},
  (CASE WHEN jsonb_typeof(pushed_campaigns) = 'array' THEN jsonb_array_length(pushed_campaigns) ELSE 0 END) AS pushed_count,
  (${TIER}) AS tier`;

// Sort keys the page may ask for. Values are full ORDER BY bodies; `id` is the
// tiebreak so paging is stable.
//
// "best" is the push ranking (selectPushCandidates) without its never-pushed
// boolean: never-contacted first (NULLS FIRST is load-bearing: NULL means never
// emailed, the LONGEST gap), then longest since last contact, then newest
// import. It matches idx_contacts_best_order so a broad filter can stream rows
// straight off the index.
const SORTS = {
  best:         { asc: `last_emailed_at ASC NULLS FIRST, imported_at DESC NULLS LAST, id`,
                  desc: `last_emailed_at ASC NULLS FIRST, imported_at DESC NULLS LAST, id` },
  imported:     { asc: `imported_at ASC NULLS LAST, id`,          desc: `imported_at DESC NULLS LAST, id` },
  last_emailed: { asc: `last_emailed_at ASC NULLS LAST, id`,      desc: `last_emailed_at DESC NULLS LAST, id` },
  verified:     { asc: `${VERIFIED_DATE} ASC NULLS LAST, id`,     desc: `${VERIFIED_DATE} DESC NULLS LAST, id` },
  employees:    { asc: `num_employees ASC NULLS LAST, id`,        desc: `num_employees DESC NULLS LAST, id` },
  company:      { asc: `LOWER(company_name) ASC NULLS LAST, id`,  desc: `LOWER(company_name) DESC NULLS LAST, id` },
  name:         { asc: `LOWER(first_name) ASC NULLS LAST, LOWER(last_name) ASC NULLS LAST, id`,
                  desc: `LOWER(first_name) DESC NULLS LAST, LOWER(last_name) DESC NULLS LAST, id` },
  title:        { asc: `LOWER(job_title) ASC NULLS LAST, id`,     desc: `LOWER(job_title) DESC NULLS LAST, id` },
  industry:     { asc: `LOWER(industry) ASC NULLS LAST, id`,      desc: `LOWER(industry) DESC NULLS LAST, id` },
};

function orderBy(sort, dir, filters) {
  // Tier A alone + "best first": every tier A row has last_emailed_at NULL, so
  // the first sort key is the same for all of them and "best first" reduces to
  // newest import first. Written that way, the ORDER BY matches
  // idx_contacts_tier_a and the page comes straight off that index. The rows
  // and their order are identical either way.
  if ((!sort || sort === 'best' || !SORTS[sort]) && filters && String(filters.tier || '').trim().toUpperCase() === 'A') {
    return `imported_at DESC NULLS LAST, id`;
  }
  const s = SORTS[sort] || SORTS.best;
  return dir === 'asc' ? s.asc : s.desc;
}

function whereFor(db, filters) {
  const { clauses, params } = db._buildFilterClauses(filters);
  return { where: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

// Run one read with its own statement_timeout, on the web pool. db.query()'s
// statementTimeoutMs option is for RAISING the limit and reroutes to the
// background pool; this is for the opposite case, a query that must give up
// quickly rather than hold a web connection for 45s.
async function timedQuery(db, sql, params, ms) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(500, parseInt(ms, 10) || 15000)}`);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    throw e;
  } finally {
    client.release();
  }
}

// ── Small TTL cache ─────────────────────────────────────────────────────────
// Bounded (unlike the original _filterCountCache Map, which never evicted).
class TtlCache {
  constructor(max = 300) { this.max = max; this.m = new Map(); }
  get(key) {
    const hit = this.m.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) { this.m.delete(key); return undefined; }
    return hit.val;
  }
  set(key, val, ttlMs) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  }
}
const countCache = new TtlCache(500);
const facetCache = new TtlCache(300);
const miscCache = new TtlCache(50);

// In-flight de-duplication: two identical requests share one query.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── Capped count ────────────────────────────────────────────────────────────
// Exact up to COUNT_CAP, then { capped: true }. Returns both values together;
// the original read a `_lastCountCapped` instance field after an await, which
// two concurrent searches could swap.
async function cappedCount(db, tenant, filters) {
  const key = `cnt|${tenant}|${filterSignature(filters)}`;
  const hit = countCache.get(key);
  if (hit) return hit;
  return once(key, async () => {
    const { where, params } = whereFor(db, filters);
    const sql = `SELECT COUNT(*)::int AS n FROM (
        SELECT 1 FROM contacts WHERE workspace_id = $1${where} LIMIT ${COUNT_CAP + 1}
      ) t`;
    let n;
    try {
      n = (await timedQuery(db, sql, [tenant, ...params], COUNT_TIMEOUT_MS)).rows[0].n;
    } catch (e) {
      if (!isTimeout(e)) throw e;
      // Too slow to count. Report "unknown" rather than hold the connection:
      // callers treat it like a broad filter and bound their own work.
      return countCache.set(key, { count: COUNT_CAP, capped: true, unknown: true }, 30000);
    }
    const out = { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, unknown: false };
    return countCache.set(key, out, 30000);
  });
}

// ── Search ──────────────────────────────────────────────────────────────────
async function search(db, tenant, filters, opts = {}) {
  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 100, 500));
  const offset = Math.max(0, Math.min(parseInt(opts.offset, 10) || 0, MAX_OFFSET));
  const order = orderBy(opts.sort, opts.dir, filters);
  const { where, params } = whereFor(db, filters);
  const t0 = Date.now();

  const { count, capped, unknown } = await cappedCount(db, tenant, filters);
  let rows = [];
  let plan = 'empty';
  let unsorted = false;
  if (count > 0) {
    if (!capped) {
      // NARROW (<= COUNT_CAP matches). Find the matching rows by whatever
      // access path suits the FILTER, then sort that small set. OFFSET 0 is an
      // optimisation fence: it stops the planner from "helpfully" walking an
      // ordering index and discarding millions of non-matching rows.
      plan = 'narrow';
      const inner = [...new Set([...LIST_COLS, 'pushed_campaigns'])].join(', ');
      const sql = `SELECT ${LIST_SELECT} FROM (
          SELECT ${inner} FROM contacts WHERE workspace_id = $1${where} OFFSET 0
        ) contacts
        ORDER BY ${order} LIMIT $${params.length + 2} OFFSET $${params.length + 3}`;
      rows = (await db.query(sql, [tenant, ...params, limit, offset])).rows;
    } else {
      // BROAD (> COUNT_CAP matches). Matches are dense, so reading rows in
      // sort order and filtering as we go fills a page after a short walk.
      plan = 'broad';
      const sql = `SELECT ${LIST_SELECT} FROM contacts
        WHERE workspace_id = $1${where}
        ORDER BY ${order} LIMIT $${params.length + 2} OFFSET $${params.length + 3}`;
      try {
        rows = (await timedQuery(db, sql, [tenant, ...params, limit, offset], BROAD_SORT_TIMEOUT_MS)).rows;
      } catch (e) {
        if (!isTimeout(e)) throw e;
        // The ordered read did not finish in time. That happens when the
        // matches sit at the far end of the sort order (or before
        // idx_contacts_best_order has been built: measured 4.9s on production
        // without it). Rather than a spinner or an error, return the page in
        // id order, which stops as soon as the page is full, and say so. id
        // order (not "no order") keeps pages from overlapping.
        plan = 'broad-unsorted';
        unsorted = true;
        const fast = `SELECT ${LIST_SELECT} FROM contacts
          WHERE workspace_id = $1${where} ORDER BY id LIMIT $${params.length + 2} OFFSET $${params.length + 3}`;
        try {
          rows = (await timedQuery(db, fast, [tenant, ...params, limit, offset], BROAD_SORT_TIMEOUT_MS * 2)).rows;
        } catch (e2) {
          if (!isTimeout(e2)) throw e2;
          const err = new Error('This filter is too slow to run on its own. Add another filter (a region, a size or a seniority) to narrow it first.');
          err.tooSlow = true;
          throw err;
        }
      }
    }
  }
  return { contacts: rows, total: count, capped, countUnknown: !!unknown, limit, offset, maxOffset: MAX_OFFSET, plan, unsorted, ms: Date.now() - t0 };
}

// ── Sampling ────────────────────────────────────────────────────────────────
// How much of the table to read for an aggregate over a broad filter.
async function tableRows(db) {
  const hit = miscCache.get('reltuples');
  if (hit != null) return hit;
  const r = await db.query(`SELECT GREATEST(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'contacts'::regclass`);
  return miscCache.set('reltuples', Number(r.rows[0]?.n) || 0, 10 * 60 * 1000);
}

// Returns { from, scale, sampled }. For a narrow filter (or a small table) the
// whole match set is read and the numbers are exact. For a broad filter a
// fixed-seed table sample is read and every count is scaled up; `sampled` tells
// the UI to show "~". The seed is fixed so the same filter gives the same
// numbers on every refresh instead of jittering.
async function sampleSource(db, tenant, filters) {
  const { capped } = await cappedCount(db, tenant, filters);
  const total = await tableRows(db);
  if (!capped || total <= SAMPLE_TARGET_ROWS * 1.5) return { from: 'contacts', scale: 1, sampled: false };
  const pct = Math.max(1, Math.min(100, Math.round((SAMPLE_TARGET_ROWS / total) * 1000) / 10));
  if (pct >= 60) return { from: 'contacts', scale: 1, sampled: false };
  return { from: `contacts TABLESAMPLE SYSTEM (${pct}) REPEATABLE (7)`, scale: 100 / pct, sampled: true };
}

// ── Facets ──────────────────────────────────────────────────────────────────
// Company-size buckets follow the standard LinkedIn/Apollo ranges ON PURPOSE.
// num_employees is not always an exact head-count: GetLeads and much of the
// Apollo data store only the LOWER BOUND of a range (measured 2026-11-14:
// GetLeads rows hold 1, 11, 51, 201, 501, 1001 and nothing else). A finer
// bucket such as "11-20" would therefore swallow every 11-50 company and
// "21-50" would miss them all. With these edges a lower bound always lands in
// its own range, so the bucket is right for exact and range-coded rows alike.
const SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'];
const SIZE_SQL = `CASE
    WHEN num_employees IS NULL THEN 'unknown'
    WHEN num_employees < 1 THEN NULL
    WHEN num_employees <= 10 THEN '1-10'
    WHEN num_employees <= 50 THEN '11-50'
    WHEN num_employees <= 200 THEN '51-200'
    WHEN num_employees <= 500 THEN '201-500'
    WHEN num_employees <= 1000 THEN '501-1000'
    WHEN num_employees <= 5000 THEN '1001-5000'
    ELSE '5001+' END`;

// Each facet: the SQL value, and `own`: the filter key(s) that select within
// this facet. A facet's counts are computed with its OWN keys removed, so every
// value shows "how many you would have if you ticked this", not zero for
// everything outside the current tick. That is what makes the list a tool for
// widening a search: the unticked values are the "more like this" options.
const FACETS = {
  seniority:   { expr: `NULLIF(seniority, '')`,               own: ['seniority'],          top: 20 },
  industry:    { expr: PostgresDatabase.INDUSTRY_NORM_SQL,    own: ['industryIs'],         top: 60 },
  size:        { expr: SIZE_SQL,                              own: ['numEmployeesRanges'], top: 12 },
  region:      { expr: `NULLIF(LOWER(company_region), '')`,   own: ['companyRegion'],      top: 20 },
  county:      { expr: `NULLIF(LOWER(company_county), '')`,   own: ['companyCounty'],      top: 80 },
  country:     { expr: `NULLIF(LOWER(company_country), '')`,  own: ['companyCountryIs'],   top: 15 },
  department:  { expr: `NULLIF(LOWER(department), '')`,       own: ['departmentIs'],       top: 25 },
  source:      { expr: `NULLIF(source, '')`,                  own: ['source'],             top: 20 },
  emailStatus: { expr: `COALESCE(email_status, 'not_verified')`, own: ['emailStatus'], top: 10 },
  provider:    { expr: `COALESCE(mx_provider, 'unknown')`,    own: ['emailProviders'],     top: 6 },
  tier:        { expr: `(${TIER})`,                           own: ['tier'],               top: 4 },
};

function without(filters, keys) {
  const f = { ...filters };
  for (const k of keys) delete f[k];
  return f;
}

// dims: array of facet names. Facets whose effective filter is identical share
// one scan (the common case: no value ticked in any of them yet).
async function facets(db, tenant, filters, dims) {
  const want = (dims || []).filter(d => FACETS[d]);
  const out = {};
  const groups = new Map(); // signature -> { filters, dims[] }
  for (const d of want) {
    const f = without(filters, FACETS[d].own);
    const sig = filterSignature(f);
    const cached = facetCache.get(`f|${tenant}|${d}|${sig}`);
    if (cached) { out[d] = cached; continue; }
    if (!groups.has(sig)) groups.set(sig, { filters: f, sig, dims: [] });
    groups.get(sig).dims.push(d);
  }

  await Promise.all([...groups.values()].map(async (g) => {
    const key = `fg|${tenant}|${g.dims.join(',')}|${g.sig}`;
    const res = await once(key, async () => {
      const { where, params } = whereFor(db, g.filters);
      const src = await sampleSource(db, tenant, g.filters);
      const cols = g.dims.map((d, i) => `${FACETS[d].expr} AS d${i}`).join(', ');
      const parts = g.dims.map((d, i) => `
        SELECT * FROM (SELECT '${d}'::text AS dim, d${i}::text AS v, COUNT(*)::bigint AS n
          FROM s WHERE d${i} IS NOT NULL GROUP BY 2 ORDER BY 3 DESC LIMIT ${FACETS[d].top}) q${i}`);
      const sql = `WITH s AS MATERIALIZED (
          SELECT ${cols} FROM ${src.from} WHERE workspace_id = $1${where}
        ) ${parts.join(' UNION ALL ')}`;
      let rows = [];
      let error = null;
      try {
        rows = (await timedQuery(db, sql, [tenant, ...params], 12000)).rows;
      } catch (e) {
        // A facet that times out must not take the page down: the list still
        // works, the counts are simply missing.
        error = /timeout/i.test(e.message) ? 'timeout' : e.message;
      }
      const byDim = {};
      for (const d of g.dims) byDim[d] = { values: [], approx: src.sampled, error };
      for (const r of rows) {
        byDim[r.dim].values.push({ value: r.v, count: Math.round(Number(r.n) * src.scale) });
      }
      return byDim;
    });
    for (const d of g.dims) {
      out[d] = res[d];
      if (!res[d].error) facetCache.set(`f|${tenant}|${d}|${g.sig}`, res[d], 120000);
    }
  }));
  return out;
}

// ── Summary (the funnel) ────────────────────────────────────────────────────
// One pass over the match set: how many match, how many are verified, how many
// have a verdict fresh enough to push without re-verifying, how many were never
// emailed. Exact for a narrow filter, a scaled sample for a broad one.
async function summary(db, tenant, filters, opts = {}) {
  const freshDays = Math.max(1, Math.min(parseInt(opts.freshVerdictDays, 10) || 3, 365));
  const key = `sum|${tenant}|${freshDays}|${filterSignature(filters)}`;
  const hit = facetCache.get(key);
  if (hit) return hit;
  return once(key, async () => {
    const { where, params } = whereFor(db, filters);
    const src = await sampleSource(db, tenant, filters);
    const safe = `LOWER(COALESCE(email_status,'')) IN ('safe','safe_catchall')`;
    const sql = `SELECT
        COUNT(*)::bigint AS matched,
        COUNT(*) FILTER (WHERE ${safe})::bigint AS verified,
        COUNT(*) FILTER (WHERE ${safe} AND ${VERIFIED_DATE} >= CURRENT_DATE - ${freshDays})::bigint AS verified_fresh,
        COUNT(*) FILTER (WHERE email_status IS NULL)::bigint AS unverified,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(email_status,'')) IN ('risky','unknown'))::bigint AS risky,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(email_status,'')) = 'invalid')::bigint AS invalid,
        COUNT(*) FILTER (WHERE last_emailed_at IS NULL AND ${NEVER_PUSHED})::bigint AS never_emailed,
        COUNT(DISTINCT LOWER(COALESCE(NULLIF(company_domain,''), split_part(email,'@',2))))::bigint AS companies
      FROM ${src.from} WHERE workspace_id = $1${where}`;
    let row;
    try {
      row = (await timedQuery(db, sql, [tenant, ...params], 15000)).rows[0];
    } catch (e) {
      return { error: /timeout/i.test(e.message) ? 'timeout' : e.message };
    }
    const sc = (v) => Math.round(Number(v || 0) * src.scale);
    const out = {
      approx: src.sampled,
      matched: sc(row.matched), verified: sc(row.verified), verifiedFresh: sc(row.verified_fresh),
      unverified: sc(row.unverified), risky: sc(row.risky), invalid: sc(row.invalid),
      neverEmailed: sc(row.never_emailed),
      // A DISTINCT count from a sample cannot be scaled up (a company with
      // several contacts would be counted once per sampled contact), so it is
      // only reported when the numbers are exact.
      companies: src.sampled ? null : Number(row.companies || 0),
      freshVerdictDays: freshDays,
    };
    return facetCache.set(key, out, 60000);
  });
}

// ── Whole-table totals (the supply side of pockets) ─────────────────────────
// Sendable contacts per value of each pocket dimension, across the whole
// tenant. One full scan, on the background pool, cached for hours: it is the
// same for every client, and it moves slowly.
const POCKET_DIMS = {
  industry:  { expr: PostgresDatabase.INDUSTRY_NORM_SQL,  filterKey: 'industryIs',         label: 'Industry' },
  seniority: { expr: `NULLIF(seniority, '')`,             filterKey: 'seniority',          label: 'Seniority' },
  size:      { expr: SIZE_SQL,                            filterKey: 'numEmployeesRanges', label: 'Company size' },
  region:    { expr: `NULLIF(LOWER(company_region), '')`, filterKey: 'companyRegion',      label: 'Region' },
  provider:  { expr: `COALESCE(mx_provider, 'unknown')`,  filterKey: 'emailProviders',     label: 'Email provider' },
  source:    { expr: `NULLIF(source, '')`,                filterKey: 'source',             label: 'Data source' },
};
const POCKET_DIM_KEYS = Object.keys(POCKET_DIMS);

const supplyState = new Map(); // tenant -> { data, at, building }
const SUPPLY_TTL_MS = 6 * 60 * 60 * 1000;

function buildSupply(db, tenant) {
  const st = supplyState.get(tenant) || {};
  if (st.building) return st.building;
  const run = (async () => {
    const t0 = Date.now();
    const cols = POCKET_DIM_KEYS.map((d, i) => `${POCKET_DIMS[d].expr} AS d${i}`).join(', ');
    const parts = POCKET_DIM_KEYS.map((d, i) => `
      SELECT '${d}'::text AS dim, d${i}::text AS v, COUNT(*)::bigint AS n FROM s WHERE d${i} IS NOT NULL GROUP BY 2`);
    const sql = `WITH s AS MATERIALIZED (
        SELECT ${cols} FROM contacts WHERE workspace_id = $1 AND ${PostgresDatabase.ALIVE_SQL}
      ) ${parts.join(' UNION ALL ')}`;
    const r = await db.query(sql, [tenant], { statementTimeoutMs: 180000 });
    const data = {};
    for (const d of POCKET_DIM_KEYS) data[d] = {};
    for (const row of r.rows) data[row.dim][row.v] = Number(row.n);
    supplyState.set(tenant, { data, at: Date.now(), building: null });
    console.log(`[contacts-next] supply totals for ${tenant} built in ${Date.now() - t0}ms`);
    return data;
  })().catch((e) => {
    console.warn('[contacts-next] supply totals failed:', e.message);
    const cur = supplyState.get(tenant) || {};
    supplyState.set(tenant, { ...cur, building: null });
    return cur.data || null;
  });
  supplyState.set(tenant, { ...st, building: run });
  return run;
}

// Returns the cached totals, or null while the first build is still running.
// A stale copy is served while a refresh runs behind it.
function supplyTotals(db, tenant) {
  const st = supplyState.get(tenant);
  if (st && st.data && Date.now() - st.at < SUPPLY_TTL_MS) return st.data;
  buildSupply(db, tenant);
  return st && st.data ? st.data : null;
}

// ── Pockets ─────────────────────────────────────────────────────────────────
// "What has worked for this client, and how much of it is left?"
//
// For one client workspace: every contact ever sent to it (emailed_workspaces
// has the workspace key) joined to the replies that client got. A POSITIVE is a
// reply marked as a lead, or classified interested / question. For each value
// of each dimension we report sent, positives, the rate, and how many sendable
// contacts with that value this client has NOT been sent yet.
//
// Honesty about small numbers: a client has ~100-350 positives in total, so a
// single value often rests on a handful. `score` therefore shrinks each rate
// towards the client's own average (as if PRIOR_SENDS extra sends at the
// average rate had been made), so "2 leads from 40 sends" cannot outrank
// "30 leads from 2,000". The raw counts are always returned for display.
const PRIOR_SENDS = 150;
const POSITIVE_SQL = `(marked_as_lead IS TRUE OR category IN ('interested', 'question'))`;

async function pockets(db, tenant, clientWs) {
  const key = `pockets|${tenant}|${clientWs}`;
  const hit = miscCache.get(key);
  // Returned exactly as built. A result built before the whole-table totals
  // were ready says supplyReady:false and is cached only briefly, so the page
  // asks again and gets one with the "left to send" numbers filled in.
  if (hit) return hit;
  return once(key, async () => {
    const t0 = Date.now();
    const cols = POCKET_DIM_KEYS.map((d, i) => `${POCKET_DIMS[d].expr} AS d${i}`).join(', ');
    const dimParts = POCKET_DIM_KEYS.map((d, i) => `
      SELECT '${d}'::text AS kind, d${i}::text AS v, NULL::text AS name, COUNT(*)::bigint AS sent,
             COUNT(*) FILTER (WHERE pos)::bigint AS pos, NULL::text AS last_at
        FROM j WHERE d${i} IS NOT NULL GROUP BY 2`);
    const sql = `
      WITH sent AS MATERIALIZED (
        SELECT LOWER(email) AS e, pushed_campaigns, ${cols}
          FROM contacts
         WHERE workspace_id = $1 AND emailed_workspaces ? $2
      ),
      pos AS MATERIALIZED (
        SELECT DISTINCT LOWER(COALESCE(NULLIF(matched_lead_email, ''), lead_email)) AS e
          FROM unibox_replies
         WHERE workspace_id = $2 AND ${POSITIVE_SQL}
      ),
      j AS MATERIALIZED (
        SELECT s.*, (p.e IS NOT NULL) AS pos FROM sent s LEFT JOIN pos p ON p.e = s.e
      )
      SELECT 'all'::text AS kind, NULL::text AS v, NULL::text AS name, COUNT(*)::bigint AS sent,
             COUNT(*) FILTER (WHERE pos)::bigint AS pos, NULL::text AS last_at FROM j
      UNION ALL ${dimParts.join(' UNION ALL ')}
      UNION ALL
      SELECT 'campaign'::text, pc->>'campaign_id', MAX(pc->>'campaign_name'), COUNT(*)::bigint,
             COUNT(*) FILTER (WHERE pos)::bigint, MAX(pc->>'pushed_at')
        FROM j, LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(j.pushed_campaigns) = 'array' THEN j.pushed_campaigns ELSE '[]'::jsonb END) pc
       WHERE pc->>'workspace_id' = $2 AND COALESCE(pc->>'campaign_id', '') <> ''
       GROUP BY 2`;
    const r = await db.query(sql, [tenant, String(clientWs)], { statementTimeoutMs: 90000 });

    const all = r.rows.find(x => x.kind === 'all') || { sent: 0, pos: 0 };
    const totalSent = Number(all.sent) || 0;
    const totalPos = Number(all.pos) || 0;
    const baseRate = totalSent ? totalPos / totalSent : 0;
    const supply = supplyTotals(db, tenant);

    const scoreOf = (sent, pos) => (pos + PRIOR_SENDS * baseRate) / (sent + PRIOR_SENDS);
    const dims = {};
    for (const d of POCKET_DIM_KEYS) dims[d] = { label: POCKET_DIMS[d].label, filterKey: POCKET_DIMS[d].filterKey, values: [] };
    const campaigns = [];
    for (const row of r.rows) {
      const sent = Number(row.sent) || 0;
      const pos = Number(row.pos) || 0;
      if (row.kind === 'campaign') {
        campaigns.push({ campaign_id: row.v, campaign_name: row.name || row.v, sent, pos,
          rate: sent ? pos / sent : 0, lift: baseRate ? scoreOf(sent, pos) / baseRate : null, last_pushed: row.last_at });
        continue;
      }
      if (!dims[row.kind]) continue;
      const have = supply && supply[row.kind] ? supply[row.kind][row.v] : null;
      dims[row.kind].values.push({
        value: row.v, sent, pos,
        rate: sent ? pos / sent : 0,
        // Shrunk rate relative to the client's average. 1.0 = average.
        lift: baseRate ? scoreOf(sent, pos) / baseRate : null,
        // Sendable contacts with this value the client has not been sent yet.
        // Approximate: whole-table sendable count minus this client's sends.
        unsent: have == null ? null : Math.max(0, have - sent),
        // Too little data to trust the rate on its own.
        thin: sent < 200 || pos < 3,
      });
    }
    for (const d of POCKET_DIM_KEYS) dims[d].values.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.sent - a.sent);
    campaigns.sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.sent - a.sent);

    const out = {
      client: String(clientWs),
      totals: { sent: totalSent, positives: totalPos, rate: baseRate },
      dims, campaigns: campaigns.slice(0, 60),
      supplyReady: !!supply,
      priorSends: PRIOR_SENDS,
      ms: Date.now() - t0,
      computedAt: new Date().toISOString(),
    };
    // Cache briefly until supply is ready so the "unsent" column fills in,
    // then for an hour: the inputs change with pushes and replies, not clicks.
    miscCache.set(key, out, supply ? 60 * 60 * 1000 : 20 * 1000);
    return out;
  });
}

// ── Lookups for the page shell ──────────────────────────────────────────────
async function sourceCounts(db, tenant) {
  const key = `sources|${tenant}`;
  const hit = miscCache.get(key);
  if (hit) return hit;
  return once(key, async () => {
    const r = await db.query(
      `SELECT source, COUNT(*)::bigint AS n FROM contacts WHERE workspace_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [tenant]);
    const rows = r.rows.filter(x => x.source).map(x => ({ value: x.source, count: Number(x.n) }));
    return miscCache.set(key, rows, 15 * 60 * 1000);
  });
}

async function gatewayNames(db) {
  const hit = miscCache.get('gateways');
  if (hit) return hit;
  try {
    const r = await db.query(`SELECT gateway, COUNT(*)::bigint AS n FROM gateway_mx_cache
                               WHERE gateway IS NOT NULL AND gateway <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);
    return miscCache.set('gateways', r.rows.map(x => ({ value: x.gateway, count: Number(x.n) })), 30 * 60 * 1000);
  } catch { return []; }
}

module.exports = {
  COUNT_CAP, MAX_OFFSET, SIZE_BUCKETS, FACETS, SORTS, POCKET_DIMS,
  search, cappedCount, facets, summary, pockets, supplyTotals, sourceCounts, gatewayNames, tableRows,
};
