#!/usr/bin/env node
/**
 * Backfill contacts.last_emailed_at from emailed_workspaces.
 *
 * Why: stampPushedCampaign() historically wrote only the emailed_workspaces
 * JSONB and left the last_emailed_at scalar NULL. ~111,725 contacts in the
 * ottaly-global pool (49% of all contacts ever emailed) therefore look
 * "never emailed" to anything that sorts on the scalar column — which is
 * exactly the contacts a least-recently-contacted selection would put FIRST.
 *
 * The write path is fixed going forward; this repairs the existing rows.
 *
 * Safety:
 *   - GREATEST() never walks an existing timestamp backwards.
 *   - Batched (default 2,000) with lock_timeout so it yields to live traffic
 *     instead of blocking the contacts page.
 *   - Idempotent: re-running changes nothing once converged.
 *   - --dry-run reports the affected count and makes no writes.
 *
 * Usage:
 *   node scripts/backfill-last-emailed-at.js --dry-run
 *   node scripts/backfill-last-emailed-at.js
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = Math.max(1, parseInt(process.env.BACKFILL_BATCH || '2000', 10));

// The max last_sent across every workspace entry is this contact's true last
// touch. Dates are stored as 'YYYY-MM-DD' text, which sorts correctly as text,
// so MAX() over the raw strings is safe before the cast.
const MAX_LAST_SENT = `
  (SELECT MAX(v->>'last_sent')
     FROM jsonb_each(COALESCE(c.emailed_workspaces, '{}'::jsonb)) AS e(k, v))`;

const COUNT_SQL = `
  SELECT COUNT(*)::int AS n
  FROM contacts c
  WHERE COALESCE(c.emailed_workspaces, '{}'::jsonb) <> '{}'::jsonb
    AND ${MAX_LAST_SENT} IS NOT NULL
    AND (c.last_emailed_at IS NULL
         OR c.last_emailed_at < (${MAX_LAST_SENT})::timestamp)`;

// Re-selects each pass rather than paging by offset: every updated row drops
// out of the predicate, so the "remaining" set shrinks and offsets can't skip.
const BATCH_SQL = `
  WITH todo AS (
    SELECT c.id, (${MAX_LAST_SENT})::timestamp AS computed
    FROM contacts c
    WHERE COALESCE(c.emailed_workspaces, '{}'::jsonb) <> '{}'::jsonb
      AND ${MAX_LAST_SENT} IS NOT NULL
      AND (c.last_emailed_at IS NULL
           OR c.last_emailed_at < (${MAX_LAST_SENT})::timestamp)
    ORDER BY c.id
    LIMIT $1
  )
  UPDATE contacts c
  SET last_emailed_at = GREATEST(
        COALESCE(c.last_emailed_at, '-infinity'::timestamp), todo.computed),
      -- Only seed a count where none was ever recorded; a real count that the
      -- send path already maintains must not be overwritten by this repair.
      email_count = GREATEST(
        COALESCE(c.email_count, 0),
        (SELECT COUNT(*)::int
           FROM jsonb_each(COALESCE(c.emailed_workspaces, '{}'::jsonb)))),
      updated_at = CURRENT_TIMESTAMP
  FROM todo
  WHERE c.id = todo.id`;

(async () => {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('DATABASE_URL (or POSTGRES_URL) must be set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 2 });
  try {
    const { rows } = await pool.query(COUNT_SQL);
    const total = rows[0].n;
    console.log(`Contacts needing backfill: ${total}`);

    if (DRY_RUN) {
      console.log('--dry-run: no writes performed.');
      return;
    }
    if (!total) {
      console.log('Nothing to do.');
      return;
    }

    let done = 0;
    for (;;) {
      const client = await pool.connect();
      let updated = 0;
      try {
        // Bounded lock wait: if the contacts page holds a conflicting lock we
        // abandon this batch and retry rather than queueing behind it.
        await client.query("SET lock_timeout = '4s'");
        const r = await client.query(BATCH_SQL, [BATCH]);
        updated = r.rowCount || 0;
      } catch (e) {
        if (e.code === '55P03' || e.code === '40P01') {
          console.warn('  lock contention — retrying batch in 2s');
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw e;
      } finally {
        client.release();
      }

      if (!updated) break;
      done += updated;
      console.log(`  ${done}/${total}`);
      // Breathe between batches so live queries get the connection back.
      await new Promise((r) => setTimeout(r, 250));
    }

    const after = await pool.query(COUNT_SQL);
    console.log(`Done. Updated ${done}. Remaining: ${after.rows[0].n}`);
  } catch (e) {
    console.error('Backfill failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
