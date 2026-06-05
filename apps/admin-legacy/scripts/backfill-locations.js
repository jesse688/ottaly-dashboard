#!/usr/bin/env node
'use strict';

/**
 * backfill-locations.js — One-time (resumable) normalisation of the location
 * hierarchy for every existing contact.
 *
 * Reads company_address / company_city / company_state / company_country (and
 * raw_data as a fallback) for each row, runs the location-normalizer, and
 * writes company_region / company_county / company_town / company_city(clean)
 * / person_* / location_source / location_needs_review.
 *
 * SAFE TO RE-RUN. By default it only touches rows not yet normalised
 * (location_normalized_at IS NULL). Pass --all to re-normalise everything
 * (e.g. after improving geo-lookup data).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/backfill-locations.js
 *   DATABASE_URL=postgres://... node scripts/backfill-locations.js --all
 *   DATABASE_URL=postgres://... node scripts/backfill-locations.js --dry-run --limit 500
 *
 * Flags:
 *   --all        re-normalise every row, not just un-normalised ones
 *   --dry-run    compute + print stats, write nothing
 *   --limit N    stop after N rows (for testing)
 *   --batch N    rows per batch (default 2000)
 */

const { Pool } = require('pg');
const { normalizeCompany, normalizePerson } = require('../location-normalizer');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY_RUN = has('--dry-run');
const ALL = has('--all');
const LIMIT = parseInt(valOf('--limit', '0'), 10) || 0;
const BATCH = parseInt(valOf('--batch', '500'), 10) || 500;
const WORKSPACE = valOf('--workspace', null);  // scope to one workspace_id

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('ERROR: set DATABASE_URL (e.g. postgres://user:pass@host:5432/ottaly)');
  process.exit(1);
}
const sslDisabled = dbUrl.includes('sslmode=disable') || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
  max: 4,
  statement_timeout: 120000,
});

function jsonRaw(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// Safely single-quote a literal (workspace ids are simple, but be careful).
function escLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Build the normalised fields for one DB row.
function deriveForRow(row) {
  const raw = jsonRaw(row.raw_data);

  const company = normalizeCompany({
    company_address: row.company_address || raw['Company Address'] || '',
    company_city:    row.company_city    || raw['Company City'] || '',
    company_state:   row.company_state   || raw['Company State'] || '',
    company_country: row.company_country || raw['Company Country'] || '',
  });

  const person = normalizePerson({
    city:    row.city    || raw['City'] || '',
    state:   row.state   || raw['State'] || '',
    country: row.country || raw['Country'] || '',
  });

  return {
    id: row.id,
    company_city:    company.city || row.company_city || null, // cleaned post town
    company_region:  company.region || null,
    company_county:  company.county || null,
    company_town:    company.town || null,
    company_country: company.country || row.company_country || null,
    person_region:   person.region || null,
    person_county:   person.county || null,
    person_town:     person.town || null,
    location_source: company.source || null,
    location_needs_review: !!company.needsReview,
    location_review_reason: company.reviewReason || null,
  };
}

// Write one batch of derived rows using a single UPDATE ... FROM (VALUES ...).
async function writeBatch(client, derived) {
  if (!derived.length) return;
  const cols = 12; // id + 11 updatable fields
  const valuesSql = [];
  const params = [];
  derived.forEach((d, i) => {
    const o = i * cols;
    valuesSql.push(`($${o+1}::uuid,$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11}::boolean,$${o+12})`);
    params.push(
      d.id, d.company_city, d.company_region, d.company_county, d.company_town,
      d.company_country, d.person_region, d.person_county, d.person_town,
      d.location_source, d.location_needs_review, d.location_review_reason
    );
  });
  const sql = `
    UPDATE contacts AS c SET
      company_city           = v.company_city,
      company_region         = v.company_region,
      company_county         = v.company_county,
      company_town           = v.company_town,
      company_country        = v.company_country,
      person_region          = v.person_region,
      person_county          = v.person_county,
      person_town            = v.person_town,
      location_source        = v.location_source,
      location_needs_review  = v.location_needs_review,
      location_review_reason = v.location_review_reason,
      location_normalized_at = NOW()
    FROM (VALUES ${valuesSql.join(',')}) AS
      v(id, company_city, company_region, company_county, company_town,
        company_country, person_region, person_county, person_town,
        location_source, location_needs_review, location_review_reason)
    WHERE c.id = v.id;`;
  await client.query(sql, params);
}

async function main() {
  // Optional workspace scoping — used to target the prospecting pool only.
  const conds = [];
  if (!ALL) conds.push('location_normalized_at IS NULL');
  if (WORKSPACE) conds.push(`workspace_id = ${escLiteral(WORKSPACE)}`);
  const whereNew = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) AS n FROM contacts ${whereNew}`;
  const { rows: [{ n: totalStr }] } = await pool.query(countSql);
  const total = parseInt(totalStr, 10);
  console.log(`[backfill] rows to process: ${total}${ALL ? ' (--all)' : ' (un-normalised only)'}${WORKSPACE ? `  workspace=${WORKSPACE}` : ''}${DRY_RUN ? '  [DRY RUN]' : ''}`);
  if (total === 0) { await pool.end(); return; }

  const stats = { processed: 0, postcode: 0, place: 0, county: 0, country: 0, none: 0, review: 0 };
  const regionCounts = {};  // company_region -> count (for split design)
  // Apollo split (Option B): Account 1 = London + South East, Account 2 = rest.
  const ACCOUNT1_REGIONS = new Set(['London', 'South East']);
  const cityByAccount = { 1: {}, 2: {} };
  const acctTotals = { 1: 0, 2: 0, unresolved: 0 };
  const t0 = Date.now();

  // Keyset pagination by id so it's resumable and stable under concurrent
  // writes. We re-query each loop for the next un-normalised slice.
  let lastId = '00000000-0000-0000-0000-000000000000';
  while (true) {
    if (LIMIT && stats.processed >= LIMIT) break;

    // Build the page WHERE: keyset (id > lastId) + same scoping as the count.
    const pageConds = ['id > $1'];
    if (!ALL) pageConds.push('location_normalized_at IS NULL');
    if (WORKSPACE) pageConds.push(`workspace_id = ${escLiteral(WORKSPACE)}`);
    const selSql = `
      SELECT id, raw_data, company_address, company_city, company_state, company_country,
             city, state, country
      FROM contacts
      WHERE ${pageConds.join(' AND ')}
      ORDER BY id
      LIMIT $2`;
    const take = LIMIT ? Math.min(BATCH, LIMIT - stats.processed) : BATCH;
    const { rows } = await pool.query(selSql, [lastId, take]);
    if (!rows.length) break;

    const derived = rows.map(deriveForRow);
    for (const d of derived) {
      stats[d.location_source || 'none'] = (stats[d.location_source || 'none'] || 0) + 1;
      if (d.location_needs_review) stats.review++;
      if (d.company_region) {
        regionCounts[d.company_region] = (regionCounts[d.company_region] || 0) + 1;
        const acct = ACCOUNT1_REGIONS.has(d.company_region) ? 1 : 2;
        acctTotals[acct]++;
        if (d.company_city) cityByAccount[acct][d.company_city] = (cityByAccount[acct][d.company_city] || 0) + 1;
      } else {
        acctTotals.unresolved++;
      }
    }

    if (!DRY_RUN) {
      // Retry with a FRESH connection on deadlock — after a deadlock Postgres
      // rolls back the transaction so the same client is unusable for retry.
      for (let attempt = 1; attempt <= 6; attempt++) {
        const client = await pool.connect();
        try {
          await writeBatch(client, derived);
          break; // success
        } catch (err) {
          if ((err.code === '40P01' || err.code === '40001') && attempt < 6) {
            const wait = 300 * attempt + Math.floor(Math.random() * 300);
            process.stdout.write(`\r[backfill] deadlock, retry ${attempt}/5 in ${wait}ms...   `);
            await new Promise(r => setTimeout(r, wait));
          } else {
            throw err;
          }
        } finally {
          client.release();
        }
      }
      // Small sleep between batches so the app's own writes have room to land.
      await new Promise(r => setTimeout(r, 50));
    }

    stats.processed += rows.length;
    lastId = rows[rows.length - 1].id;

    const pct = total ? ((stats.processed / total) * 100).toFixed(1) : '?';
    const rate = Math.round(stats.processed / ((Date.now() - t0) / 1000));
    process.stdout.write(`\r[backfill] ${stats.processed}/${total} (${pct}%)  ~${rate}/s   `);

    // --all keyset advances by id; un-normalised mode also advances by id but
    // rows just written now have location_normalized_at set, so they drop out.
    if (rows.length < take) break;
  }

  console.log('\n[backfill] done.');
  console.table({
    processed: stats.processed,
    'via postcode': stats.postcode,
    'via place name': stats.place,
    'via county': stats.county,
    'country only': stats.country,
    'no signal': stats.none,
    'flagged for review': stats.review,
  });
  // Region distribution — the basis for the Apollo 50/50 split.
  const regionRows = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]);
  if (regionRows.length) {
    const resolved = regionRows.reduce((s, [, n]) => s + n, 0);
    console.log('\n[backfill] region distribution (resolved rows):');
    const tbl = {};
    let cum = 0;
    for (const [region, n] of regionRows) {
      cum += n;
      tbl[region] = { count: n, pct: ((n / resolved) * 100).toFixed(1) + '%', cumulative: cum };
    }
    console.table(tbl);
    console.log(`[backfill] resolved-with-region total: ${resolved}  (half = ${Math.round(resolved / 2)})`);
  }

  // Apollo split city lists (Option B) — the actual filter content per account.
  if (acctTotals[1] || acctTotals[2]) {
    console.log('\n========== APOLLO SPLIT (Option B: London+South East vs Rest) ==========');
    console.log(`Account 1 (London + South East): ${acctTotals[1]} resolved`);
    console.log(`Account 2 (all other regions):   ${acctTotals[2]} resolved`);
    console.log(`Unresolved (no region):          ${acctTotals.unresolved}`);
    for (const acct of [1, 2]) {
      const cities = Object.entries(cityByAccount[acct]).sort((a, b) => b[1] - a[1]);
      const top = cities.slice(0, 60);
      const covered = top.reduce((s, [, n]) => s + n, 0);
      const totalAcct = cities.reduce((s, [, n]) => s + n, 0);
      console.log(`\n----- ACCOUNT ${acct}: top ${top.length} cities (${((covered / totalAcct) * 100).toFixed(1)}% of this account; ${cities.length} distinct cities total) -----`);
      console.log(top.map(([c, n]) => `${c} (${n})`).join(', '));
    }
    console.log('\n(Paste the city names into each Apollo account\'s Company Location filter.)');
  }

  if (DRY_RUN) console.log('[backfill] DRY RUN — nothing was written.');
  await pool.end();
}

main().catch(err => { console.error('\n[backfill] FAILED:', err); process.exit(1); });
