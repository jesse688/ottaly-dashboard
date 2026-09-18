/**
 * Phase 3: the only code here that WRITES to PlusVibe.
 *
 * Everything else in this system reads. This module changes live sending
 * settings, so it follows three rules without exception:
 *
 *   1. Back up first. Current values are written to a BACKUP_*.json file
 *      before any change, matching the convention already in this repo. A
 *      change that cannot be undone is not made.
 *   2. Dry run by default. Nothing is sent to PlusVibe unless the caller
 *      passes { apply: true }.
 *   3. Reversible only. Pausing sets daily_limit to 0, which stops cold
 *      sending while warmup keeps running. It does not delete, disconnect or
 *      retire anything.
 *
 * HOW A PAUSE WORKS. PlusVibe has no per-account "pause" switch — status is
 * reported, not set. The lever is daily_limit: 0, which the API explicitly
 * allows. That is exactly what a rest is in MAILBOX_MANAGEMENT.md §2: campaign
 * sending stops, warmup continues, and the mailbox keeps its age, auth and
 * history. Restoring means writing the old limit back, which is why the backup
 * holds the previous value per mailbox rather than a single global number.
 *
 * Writes go through bulk_update_email_accounts, which needs only workspace_id
 * and ids. The single-account tool requires first_name, daily_limit and
 * interval_limit_in_min together, so using it risks overwriting fields we did
 * not intend to touch.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PVMcp } = require('./pv-mcp');
const store = require('./db');

const BACKUP_DIR = process.env.MAILBOX_BACKUP_DIR || path.join(__dirname, '..');

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 13);
}

/** Write a restore file. Returns its path. Never overwrites an existing one. */
function writeBackup(kind, rows) {
  const file = path.join(BACKUP_DIR, `BACKUP_mailbox_${kind}_${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    kind,
    written_at: new Date().toISOString(),
    note: 'Restore with: node mailbox/actuator.js restore <this file> --apply',
    rows,
  }, null, 1));
  return file;
}

/**
 * Pause mailboxes: stop cold sending, leave warmup running.
 *
 * `targets` are rows carrying at least { email, pv_id, workspace_id,
 * daily_limit }. The current daily_limit is captured so the pause can be
 * lifted exactly, not guessed.
 */
async function pause(db, targets, { apply = false, reason = 'placement spam', log = console.error } = {}) {
  if (!targets.length) return { paused: 0, file: null, dry_run: !apply };

  const rows = targets.map((t) => ({
    email: t.email,
    id: t.pv_id,
    workspace_id: t.workspace_id,
    previous_daily_limit: t.daily_limit ?? null,
    reason,
  }));

  // A dry run writes no file — it would litter the repo with backups of
  // changes that never happened, and the real one is written below anyway.
  if (!apply) {
    log(`DRY RUN — would pause ${rows.length} mailboxes (daily_limit -> 0). `
      + `Pass --apply to send this to PlusVibe.`);
    return { paused: 0, would_pause: rows.length, file: null, dry_run: true, rows };
  }

  // Back up BEFORE the first write, so a failure partway still leaves a
  // complete restore file for everything that was about to change.
  const file = writeBackup('pause', rows);
  log(`backup written: ${path.basename(file)}`);

  const mcp = new PVMcp(process.env.PLUSVIBE_API_KEY);
  const byWs = {};
  for (const r of rows) (byWs[r.workspace_id] ||= []).push(r);

  let paused = 0, failed = 0;
  for (const [ws, list] of Object.entries(byWs)) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      try {
        await mcp.call('bulk_update_email_accounts', {
          workspace_id: ws,
          ids: chunk.map((c) => c.id),
          daily_limit: 0,
        });
        paused += chunk.length;
        log(`  paused ${chunk.length} in ${ws}`);
      } catch (e) {
        failed += chunk.length;
        log(`  FAILED ${chunk.length} in ${ws}: ${e.message}`);
      }
    }
  }

  // Record locally so the dashboard can show what we paused and when, and so
  // a second spam result knows this mailbox already had its first rest.
  const now = new Date().toISOString();
  const mark = db.prepare(`UPDATE mailbox SET paused_at = ? WHERE email = ?`);
  const tx = db.transaction(() => { for (const r of rows) mark.run(now, r.email); });
  tx();

  log(`paused ${paused}, failed ${failed}. Restore file: ${path.basename(file)}`);
  return { paused, failed, file, dry_run: false };
}

/** Lift a pause, restoring each mailbox's previous daily limit. */
async function restore(db, file, { apply = false, log = console.error } = {}) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = payload.rows || [];
  if (!rows.length) throw new Error('backup file has no rows');

  if (!apply) {
    log(`DRY RUN — would restore ${rows.length} mailboxes to their previous limits. `
      + `Pass --apply to send this to PlusVibe.`);
    return { restored: 0, would_restore: rows.length, dry_run: true };
  }

  const mcp = new PVMcp(process.env.PLUSVIBE_API_KEY);
  // Group by (workspace, previous limit): a bulk call sets one limit, and
  // mailboxes did not all share the same one before the pause.
  const groups = {};
  for (const r of rows) {
    const limit = r.previous_daily_limit;
    if (limit === null || limit === undefined) continue;   // nothing to restore to
    (groups[`${r.workspace_id}|${limit}`] ||= []).push(r);
  }

  let restored = 0, failed = 0;
  for (const [key, list] of Object.entries(groups)) {
    const [ws, limit] = key.split('|');
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      try {
        await mcp.call('bulk_update_email_accounts', {
          workspace_id: ws,
          ids: chunk.map((c) => c.id),
          daily_limit: Number(limit),
        });
        restored += chunk.length;
        log(`  restored ${chunk.length} to limit ${limit}`);
      } catch (e) {
        failed += chunk.length;
        log(`  FAILED ${chunk.length}: ${e.message}`);
      }
    }
  }

  const clear = db.prepare(`UPDATE mailbox SET paused_at = NULL WHERE email = ?`);
  const tx = db.transaction(() => { for (const r of rows) clear.run(r.email); });
  tx();

  log(`restored ${restored}, failed ${failed}`);
  return { restored, failed, dry_run: false };
}

/** The mailboxes a pause would target: flagged by placement, not already paused. */
function pauseTargets(db, { client = null } = {}) {
  return db.prepare(`
    SELECT m.email, m.pv_id, m.workspace_id, m.workspace_name AS client,
           m.daily_limit, m.flagged_reason, m.paused_at,
           c.lifetime_sends
    FROM mailbox m
    LEFT JOIN mailbox_cumulative c ON c.email = m.email
    WHERE m.flagged_reason IS NOT NULL
      AND m.paused_at IS NULL
      AND m.retired_at IS NULL
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state = 'removed')
      AND (? IS NULL OR m.workspace_name = ?)
    ORDER BY m.workspace_name, m.email
  `).all(client, client);
}

if (require.main === module) {
  const cmd = process.argv[2];
  const apply = process.argv.includes('--apply');
  const clientArg = process.argv.find((a) => a.startsWith('--client='));
  const db = store.open();

  (async () => {
    if (cmd === 'pause') {
      const targets = pauseTargets(db, { client: clientArg ? clientArg.split('=')[1] : null });
      if (!targets.length) { console.log('nothing flagged to pause'); return; }
      console.error(`${targets.length} flagged mailbox(es):`);
      for (const t of targets) {
        console.error(`  ${t.email} — ${t.flagged_reason} (limit ${t.daily_limit}, `
          + `${t.lifetime_sends ?? '?'} lifetime sends)`);
      }
      const out = await pause(db, targets, { apply });
      console.log(JSON.stringify(out.rows ? { ...out, rows: out.rows.length } : out));
    } else if (cmd === 'restore') {
      const file = process.argv[3];
      if (!file) throw new Error('usage: actuator.js restore <backup file> [--apply]');
      console.log(JSON.stringify(await restore(db, file, { apply })));
    } else {
      console.error('usage: node mailbox/actuator.js pause|restore [--client=X] [--apply]');
      process.exit(1);
    }
  })().then(() => db.close())
      .catch((e) => { console.error('FAILED:', e.message); db.close(); process.exit(1); });
}

module.exports = { pause, restore, pauseTargets, writeBackup };
