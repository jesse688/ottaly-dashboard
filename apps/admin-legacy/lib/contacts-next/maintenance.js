// Background upkeep for the contacts table, run a few minutes after boot.
//
// Three jobs, in this order, all under one advisory lock so only one app
// instance ever does them:
//
//   1. DROP two indexes nothing uses (10.6 GB between them).
//   2. BUILD the two indexes contacts v2 is shaped around.
//   3. One-off data fix: store the exact head-count on contacts that have one.
//
// Why it waits for the app's own schema setup instead of a fixed delay: on
// every start setupSchema() runs ~90 `ALTER TABLE contacts ADD COLUMN IF NOT
// EXISTS` statements and re-creates the updated_at trigger. Each needs a brief
// exclusive lock on contacts, with a 5s lock timeout. A CREATE INDEX
// CONCURRENTLY that overlaps them is a mutual block: the ALTERs time out one by
// one (stretching the list to many minutes), and when the index build reaches
// its "wait for older transactions" phase Postgres kills it as a deadlock. That
// happened at 20s after boot and again at 3 minutes (production, 2026-11-14),
// each time leaving an invalid index. So upkeep starts only after
// pgdb.schemaReady resolves plus a short settle, and retries a failed step.

const LOCK_KEY = 772011514; // arbitrary constant, unique to this helper
// Settle time AFTER the app's schema setup has finished.
const SETTLE_MS = Number(process.env.CONTACTS_NEXT_MAINT_DELAY_MS) || 90 * 1000;
const RETRY_DELAY_MS = Number(process.env.CONTACTS_NEXT_MAINT_RETRY_MS) || 3 * 60 * 1000;
const MAX_ATTEMPTS = 6;

// Indexes with zero scans that cost real money on every write. Measured on
// production 2026-11-14 (stats covering 27 days of normal use):
//   idx_contacts_keywords_trgm  7.1 GB, 0 scans. Every keywords filter wraps
//       the column in COALESCE(NULLIF(keywords,''), raw_data->>'Keywords'),
//       which this index cannot serve; the search_tsv prefilter does the job.
//   idx_contacts_raw_data_gin   3.5 GB, 0 scans. No query anywhere uses a
//       containment operator on raw_data.
// (idx_contacts_technologies_trgm also showed 0 scans but is deliberately NOT
// here: EXPLAIN shows the Technologies filter uses it. It was simply not used
// in that window.) Their CREATE statements were removed from db-postgres.js
// and db-schema-postgres.sql in the same change, so they are not rebuilt.
const DROP_INDEXES = ['idx_contacts_keywords_trgm', 'idx_contacts_raw_data_gin'];

//   idx_contacts_best_order      matches the default "best first" sort, so a
//       broad filter streams a page straight off the index instead of sorting
//       every match (4.9s -> 78ms measured on production).
//   idx_contacts_emailed_ws_keys makes `emailed_workspaces ? <client>` an index
//       lookup. The older GIN on that column is jsonb_path_ops, which does not
//       support `?`, so "everything this client was sent" was a full scan.
//   idx_contacts_tier_a          a small partial index over tier A candidates
//       (verified safe, never emailed), newest import first. Serves the "Ready
//       now" quick pick, which was a 6s walk of the general sort index.
//   idx_contacts_company_domain_lower_trgm  lets "company name or website
//       contains" use an index for the website half. The name half already had
//       one; with only one side indexed Postgres falls back to reading every row.
const { TIER_A_INDEX_PREDICATE } = require('../../db-postgres');
const BUILD_INDEXES = [
  ['idx_contacts_company_domain_lower_trgm',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_company_domain_lower_trgm
      ON contacts USING GIN (LOWER(company_domain) gin_trgm_ops)`],
  ['idx_contacts_tier_a',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_tier_a
      ON contacts (workspace_id, imported_at DESC NULLS LAST, id)
      WHERE ${TIER_A_INDEX_PREDICATE}`],
  ['idx_contacts_best_order',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_best_order
      ON contacts (workspace_id, last_emailed_at ASC NULLS FIRST, imported_at DESC NULLS LAST, id)`],
  ['idx_contacts_emailed_ws_keys',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_emailed_ws_keys
      ON contacts USING GIN (emailed_workspaces jsonb_ops)`],
];

const HEADCOUNT_MIGRATION = 'contacts-exact-headcount-v1';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (...a) => console.log('[contacts-maint]', ...a);
const warn = (...a) => console.warn('[contacts-maint]', ...a);

async function indexState(client, name) {
  const r = await client.query(
    `SELECT c.oid, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`, [name]);
  return r.rows[0] || null;
}

async function dropUnused(client) {
  let ok = true;
  for (const name of DROP_INDEXES) {
    try {
      if (!(await indexState(client, name))) continue;
      const t0 = Date.now();
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      log(`dropped ${name} in ${Date.now() - t0}ms`);
    } catch (e) { ok = false; warn(`${name} not dropped:`, e.message); }
  }
  return ok;
}

async function buildNeeded(client) {
  let ok = true;
  for (const [name, sql] of BUILD_INDEXES) {
    try {
      const st = await indexState(client, name);
      if (st && st.indisvalid) continue;
      if (st) {
        // Present but not valid: either still being built by someone, or the
        // wreck of an interrupted build. Leave a live build alone; clear a wreck.
        const busy = await client.query(`SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = $1 LIMIT 1`, [st.oid]);
        if (busy.rows.length) { log(`${name} is already being built`); ok = false; continue; }
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      }
      const t0 = Date.now();
      await client.query(sql);
      log(`${name} ready in ${Date.now() - t0}ms`);
    } catch (e) { ok = false; warn(`${name} not built:`, e.message); }
  }
  return ok;
}

// ── Exact head-count backfill ───────────────────────────────────────────────
// num_employees on GetLeads-derived rows holds the LOWER BOUND of a range
// ("11 to 50" -> 11). About two thirds of those rows also carry the exact
// LinkedIn head-count in raw_data, unused. This copies it across.
//
//   - Walks the table once by id, a few thousand rows at a time, with a pause
//     between batches, so it never holds a lock for long.
//   - Records every change (old and new value) in a backup table first, so it
//     can be reversed row for row.
//   - Runs with triggers off for its own statements: the update must not bump
//     updated_at on ~350k rows. A mass update on 2026-08-19 did exactly that
//     and made "updated in the last 30 days" return the whole table.
//   - Safe to interrupt: it only touches rows whose value still differs, and is
//     marked done in _migrations only when a full pass completes.
async function backfillHeadcount(client) {
  const BATCH = Number(process.env.CONTACTS_NEXT_HEADCOUNT_BATCH) || 3000;
  await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  if ((await client.query(`SELECT 1 FROM _migrations WHERE name = $1`, [HEADCOUNT_MIGRATION])).rows.length) return true;
  await client.query(`CREATE TABLE IF NOT EXISTS _backup_num_employees_exact_v1 (
      id UUID PRIMARY KEY, old_num_employees INTEGER, new_num_employees INTEGER,
      changed_at TIMESTAMPTZ DEFAULT now())`);

  const t0 = Date.now();
  let last = '00000000-0000-0000-0000-000000000000';
  let seen = 0; let changed = 0; let errors = 0;
  for (;;) {
    try {
      await client.query('BEGIN');
      // Triggers off for this transaction only (needs a superuser connection,
      // which the app's is). If that is refused, stop: better no fix than a
      // fix that rewrites updated_at.
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(`SET LOCAL lock_timeout = '4s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);
      const r = await client.query(`
        WITH c AS MATERIALIZED (
          SELECT id, num_employees AS old,
                 CASE WHEN raw_data->>'linkedin_employee_count_exact' ~ '^[0-9]{1,7}$'
                      THEN (raw_data->>'linkedin_employee_count_exact')::int END AS exact
            FROM contacts WHERE id > $1::uuid ORDER BY id LIMIT $2
        ),
        todo AS (SELECT id, old, exact FROM c WHERE exact >= 1 AND old IS DISTINCT FROM exact),
        bk AS (
          INSERT INTO _backup_num_employees_exact_v1 (id, old_num_employees, new_num_employees)
          SELECT id, old, exact FROM todo ON CONFLICT (id) DO NOTHING RETURNING 1
        ),
        upd AS (
          UPDATE contacts t SET num_employees = todo.exact FROM todo WHERE t.id = todo.id RETURNING 1
        )
        SELECT (SELECT id FROM c ORDER BY id DESC LIMIT 1) AS last,
               (SELECT COUNT(*) FROM c)::int AS seen,
               (SELECT COUNT(*) FROM upd)::int AS changed,
               (SELECT COUNT(*) FROM bk)::int AS backed`, [last, BATCH]);
      await client.query('COMMIT');
      const row = r.rows[0];
      if (!row.seen) break;
      last = row.last; seen += row.seen; changed += row.changed; errors = 0;
      if (seen % (BATCH * 50) === 0) log(`head-count backfill: ${seen} rows read, ${changed} updated`);
      await sleep(row.changed ? 250 : 20);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      if (/permission denied|must be superuser/i.test(e.message)) { warn('head-count backfill skipped: cannot switch triggers off:', e.message); return false; }
      if (++errors >= 5) { warn('head-count backfill stopped after repeated errors:', e.message); return false; }
      await sleep(5000);
    }
  }
  await client.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [HEADCOUNT_MIGRATION]);
  log(`head-count backfill done: ${seen} rows read, ${changed} updated, ${Math.round((Date.now() - t0) / 1000)}s. Old values are in _backup_num_employees_exact_v1.`);
  return true;
}

// ── Empty the stale audience scores ─────────────────────────────────────────
// audience_scores held 6.7M rows / 7.9 GB, last computed 2026-09-11. Its only
// reader is the "recommended" panel on the classic contacts page; the "What
// works" tab on the new page replaces it and reads live reply data instead.
// Emptied once, with Jesse's OK (2026-11-14). The table itself stays, so the
// classic panel shows "no scores yet" rather than an error, and its Refresh
// button can still rebuild scores if anyone wants them back.
const AUDIENCE_MIGRATION = 'audience-scores-truncate-v1';
async function emptyAudienceScores(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  if ((await client.query(`SELECT 1 FROM _migrations WHERE name = $1`, [AUDIENCE_MIGRATION])).rows.length) return true;
  try {
    const exists = await client.query(`SELECT to_regclass('public.audience_scores') AS t`);
    if (exists.rows[0].t) {
      const before = await client.query(`SELECT pg_size_pretty(pg_total_relation_size('audience_scores')) AS size, (SELECT reltuples::bigint FROM pg_class WHERE oid = 'audience_scores'::regclass) AS n`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`TRUNCATE TABLE audience_scores`);
      await client.query('COMMIT');
      log(`audience_scores emptied (was ${before.rows[0].size}, about ${before.rows[0].n} rows)`);
    }
    await client.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [AUDIENCE_MIGRATION]);
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* not in a transaction */ }
    warn('audience_scores not emptied:', e.message);
    return false;
  }
}

// One pass. Returns true when nothing is left to do.
async function runOnce(pgdb) {
  const pool = pgdb.bgPool || pgdb.pool;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])).rows[0].ok;
    if (!locked) { log('another instance is handling upkeep'); return true; }
    await client.query(`SET statement_timeout = 0`);
    const dropped = await dropUnused(client);
    const built = await buildNeeded(client);
    const filled = process.env.CONTACTS_NEXT_SKIP_HEADCOUNT === '1' ? true : await backfillHeadcount(client);
    const emptied = await emptyAudienceScores(client);
    return dropped && built && filled && emptied;
  } finally {
    if (locked) { try { await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]); } catch { /* ending the session frees it */ } }
    try { await client.query(`SET statement_timeout = 45000`); } catch { /* connection may be dead */ }
    client.release();
  }
}

function schedule(pgdb) {
  if (process.env.CONTACTS_NEXT_SKIP_MAINTENANCE === '1' || process.env.CONTACTS_NEXT_SKIP_INDEXES === '1') return;
  let attempt = 0;
  const tick = async () => {
    attempt++;
    let done = false;
    try { done = await runOnce(pgdb); } catch (e) { warn('upkeep pass failed:', e.message); }
    if (!done && attempt < MAX_ATTEMPTS) { const t = setTimeout(tick, RETRY_DELAY_MS); if (t.unref) t.unref(); }
    else if (!done) warn(`upkeep still incomplete after ${attempt} attempts; it will try again on the next start`);
  };
  // schemaReady never rejects (db-postgres.js catches); the fallback covers a
  // database class that does not expose it.
  Promise.resolve(pgdb.schemaReady).catch(() => {}).then(() => {
    const t = setTimeout(tick, SETTLE_MS);
    if (t.unref) t.unref();
  });
}

module.exports = { schedule, runOnce, DROP_INDEXES, BUILD_INDEXES, HEADCOUNT_MIGRATION };
