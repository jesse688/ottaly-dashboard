/**
 * Mailbox ingest — the foundation of the mailbox system.
 *
 * Two modes:
 *   backfill  walks each workspace back in 90-day windows to the oldest
 *             mailbox creation date, banking every day it finds. Run once.
 *   nightly   refreshes the roster and the most recent window only.
 *
 * Why this exists at all: PlusVibe has no lifetime send count and refuses any
 * date range over 90 days, so cumulative sends — the number the whole system
 * judges a mailbox on — can only be built by stitching windows and storing
 * them. A day that is not banked before it falls out of reach is gone.
 *
 * Usage:
 *   node mailbox/ingest.js backfill
 *   node mailbox/ingest.js nightly
 *   node mailbox/ingest.js backfill --workspace=ShireRecoveries
 */

require('dotenv').config();
const { PV, windows, fmt, chartRow, CHUNK } = require('./pv');
const store = require('./db');

// Workspaces never worth ingesting: test and scratch accounts, not clients.
// Real clients who leave are marked 'removed' in client_state from the
// dashboard instead, so the list below does not need editing when one goes.
const NEVER_INGEST = new Set([
  'Ottaly Test Account',
  "Tristan's Workspace",
]);

/**
 * Removed clients stop being ingested — there is no point spending API calls
 * on a workspace nobody sends from. Their stored history is kept, so if one
 * comes back their past numbers are still there and only the gap needs
 * backfilling.
 */
function excludedFor(db) {
  const gone = require('./db').clientsInState(db, 'removed');
  return new Set([...NEVER_INGEST, ...gone]);
}

const nowIso = () => new Date().toISOString();

function mailboxRow(a, ws) {
  return {
    email: (a.email || '').toLowerCase(),
    pv_id: a.id,
    workspace_id: ws.id,
    workspace_name: ws.name,
    domain: (a.email || '').split('@')[1] || '',
    provider: a.provider || null,
    status: a.status || null,
    warmup_status: a.warmup_status || null,
    in_recovery: a.in_recovery ? 1 : 0,
    created_at: a.timestamp_created || null,
    daily_limit: a.payload?.daily_limit ?? null,
    auto_pause: a.payload?.is_auto_pause ?? null,
    rand_pct: a.payload?.limit_rand_pct ?? null,
  };
}

async function run({ mode = 'nightly', only = null, log = console.error } = {}) {
  const db = store.open();
  const pv = new PV(process.env.PLUSVIBE_API_KEY);
  const started = nowIso();
  const runId = store.startRun(db, mode, started);
  const stats = { workspaces: 0, mailboxes: 0, apiCalls: 0, errors: 0 };

  try {
    const all = await pv.workspaces();
    const excluded = excludedFor(db);
    const wss = all.filter((w) => !excluded.has(w.name))
                   .filter((w) => !only || w.name === only);
    log(`${mode}: ${wss.length} workspaces in scope`
      + (excluded.size ? ` (${excluded.size} excluded)` : ''));

    for (const ws of wss) {
      let accounts;
      try {
        accounts = await pv.accounts(ws.id);
      } catch (e) {
        log(`  ${ws.name}: roster failed — ${e.message}`);
        stats.errors++;
        continue;
      }
      if (!accounts.length) continue;

      const rows = accounts.map((a) => mailboxRow(a, ws)).filter((r) => r.email);
      store.upsertMailboxes(db, rows, nowIso());
      stats.workspaces++;
      stats.mailboxes += rows.length;

      // How far back to walk. Backfill goes to the oldest mailbox in the
      // workspace; nightly only refreshes the current window.
      const oldest = rows.reduce(
        (m, r) => (r.created_at && new Date(r.created_at) < m ? new Date(r.created_at) : m),
        new Date()
      );
      const from = mode === 'backfill'
        ? oldest
        : new Date(Date.now() - 6 * 86400000);
      const wins = windows(from, new Date());

      const byId = new Map(accounts.map((a) => [a.id, (a.email || '').toLowerCase()]));
      let banked = 0;

      for (const w of wins) {
        const key = [fmt(w.start), fmt(w.end)];
        // Skip windows already banked, except the newest — today's numbers move.
        const isCurrent = w === wins[0];
        if (!isCurrent && store.haveWindow(db, ws.id, key[0], key[1])) continue;

        let winRows = 0;
        for (let i = 0; i < accounts.length; i += CHUNK) {
          const chunk = accounts.slice(i, i + CHUNK);
          let res;
          try {
            res = await pv.bulkStats(ws.id, chunk.map((a) => a.id), w.start, w.end);
          } catch (e) {
            log(`  ${ws.name} ${key[0]}..${key[1]}: ${e.message}`);
            stats.errors++;
            continue;
          }

          const daily = [];
          const winHeaders = [];
          for (const r of res) {
            const email = (r.email || byId.get(r.email_acc_id) || '').toLowerCase();
            if (!email) continue;
            for (const p of r.chart || []) {
              const row = chartRow(email, p);
              // Only bank days with activity — empty days are noise and the
              // absence of a row is itself meaningful (a rest day).
              if (row.sent || row.ooo || row.replies || row.contacted) daily.push(row);
            }
            const h = r.header || {};
            winHeaders.push({
              email, start_date: key[0], end_date: key[1],
              sent: h.total_sent_count || 0,
              ooo: h.total_ooo_reply_count || 0,
              replies: h.total_reply_count || 0,
              positive: h.total_pos_reply_count || 0,
              contacted: h.total_contacted_count || 0,
              bounce: h.total_bounce_count || 0,
              recipient_bounce: h.recipient_bounce_count || 0,
              sender_bounce: h.sender_bounce_count || 0,
            });
          }
          if (daily.length) store.insertDaily(db, daily);
          if (winHeaders.length) store.insertWindows(db, winHeaders);
          winRows += daily.length;
        }

        store.markWindow(db, ws.id, key[0], key[1], winRows, nowIso());
        banked += winRows;
      }
      log(`  ${ws.name}: ${rows.length} mbx, ${wins.length} window(s), ${banked} day-rows`);
    }

    const n = store.rebuildCumulative(db, nowIso());
    log(`cumulative rebuilt for ${n} mailboxes`);

    stats.apiCalls = pv.calls;
    stats.errors += pv.errors;
    store.finishRun(db, runId, stats, nowIso());
    log(`done: ${stats.mailboxes} mailboxes, ${stats.apiCalls} API calls, ${stats.errors} errors`);
    return stats;
  } catch (e) {
    stats.apiCalls = pv.calls;
    store.finishRun(db, runId, { ...stats, note: e.message }, nowIso());
    throw e;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const mode = process.argv[2] === 'backfill' ? 'backfill' : 'nightly';
  const wsArg = process.argv.find((a) => a.startsWith('--workspace='));
  run({ mode, only: wsArg ? wsArg.split('=')[1] : null })
    .then(() => process.exit(0))
    .catch((e) => { console.error('INGEST FAILED:', e.message); process.exit(1); });
}

module.exports = { run, NEVER_INGEST, excludedFor };
