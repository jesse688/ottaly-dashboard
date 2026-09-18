/**
 * Import placement results from a JSON file into the store.
 *
 * Why a file: PlusVibe exposes placement tests through its MCP tool surface but
 * has no REST path for them under /api/v1 — every documented shape 404s
 * (checked 2026-09-17 across two bases and a dozen resource names). So the
 * pull is done with the MCP tools and handed to this importer, rather than the
 * nightly job fetching it directly.
 *
 * If a REST path appears later, point `ingestPlacement` in placement.js at it
 * and this file becomes redundant — the storage and flagging logic is shared.
 *
 * Expected shape:
 *   {
 *     runs: [
 *       { test_id, parent_id, workspace_id, name, status, sent, inbox,
 *         inbox_pct, spam_pct, created_at,
 *         senders: [ { email, results: [ {rec_type, sent_count, inbox_count,
 *                                         spam_count, prom_count, miss_count} ] } ] }
 *     ]
 *   }
 *
 * Usage: node mailbox/placement-import.js <file.json>
 */

const fs = require('fs');
const store = require('./db');
const { applyFlags, isGeneric } = require('./placement');

function importFile(db, payload, { log = console.error } = {}) {
  const now = new Date().toISOString();

  const upRun = db.prepare(`
    INSERT INTO placement_run (test_id, parent_id, workspace_id, name, status,
      sent, inbox, inbox_pct, spam_pct, created_at, fetched_at)
    VALUES (@test_id, @parent_id, @workspace_id, @name, @status,
      @sent, @inbox, @inbox_pct, @spam_pct, @created_at, @fetched_at)
    ON CONFLICT(test_id) DO UPDATE SET
      status=excluded.status, sent=excluded.sent, inbox=excluded.inbox,
      inbox_pct=excluded.inbox_pct, spam_pct=excluded.spam_pct,
      fetched_at=excluded.fetched_at
  `);
  const upRes = db.prepare(`
    INSERT INTO placement_result (test_id, email, rec_type, sent, inbox, spam,
      promotion, missing, tested_at)
    VALUES (@test_id, @email, @rec_type, @sent, @inbox, @spam,
      @promotion, @missing, @tested_at)
    ON CONFLICT(test_id, email, rec_type) DO UPDATE SET
      sent=excluded.sent, inbox=excluded.inbox, spam=excluded.spam,
      promotion=excluded.promotion, missing=excluded.missing
  `);

  let runs = 0, rows = 0, skipped = 0;
  const unknownEmails = new Set();
  const known = new Set(db.prepare(`SELECT email FROM mailbox`).all().map((r) => r.email));

  const tx = db.transaction(() => {
    for (const run of payload.runs || []) {
      // Only generic-content tests describe the MAILBOX. A test sent with live
      // campaign copy measures that copy, so a spam result there says nothing
      // about whether the mailbox itself is healthy.
      if (!isGeneric(run.name)) {
        skipped++;
        log(`  skipped (not generic): ${run.name}`);
        continue;
      }
      upRun.run({
        test_id: run.test_id, parent_id: run.parent_id || null,
        workspace_id: run.workspace_id || null, name: run.name,
        status: run.status || 'COMPLETED',
        sent: run.sent ?? null, inbox: run.inbox ?? null,
        inbox_pct: run.inbox_pct ?? null, spam_pct: run.spam_pct ?? null,
        created_at: run.created_at || now, fetched_at: now,
      });
      runs++;
      for (const s of run.senders || []) {
        const email = (s.email || '').toLowerCase();
        if (!known.has(email)) unknownEmails.add(email);
        for (const r of s.results || []) {
          upRes.run({
            test_id: run.test_id, email, rec_type: r.rec_type || 'UNKNOWN',
            sent: r.sent_count || 0, inbox: r.inbox_count || 0,
            spam: r.spam_count || 0, promotion: r.prom_count || 0,
            missing: r.miss_count || 0,
            tested_at: run.created_at || now,
          });
          rows++;
        }
      }
    }
  });
  tx();

  const { flagged, orphaned } = applyFlags(db, now);
  log(`imported ${runs} runs, ${rows} rows, ${skipped} non-generic skipped, `
    + `${unknownEmails.size} sender${unknownEmails.size === 1 ? '' : 's'} no longer in PlusVibe, `
    + `${flagged} mailboxes flagged`
    + (orphaned ? ` (${orphaned} spam results belong to deleted mailboxes)` : ''));
  return { runs, rows, skipped, unknown: unknownEmails.size, flagged, orphaned };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node mailbox/placement-import.js <file.json>'); process.exit(1); }
  const db = store.open();
  try {
    const out = importFile(db, JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(JSON.stringify(out));
  } finally { db.close(); }
}

module.exports = { importFile };
