/**
 * Placement test ingest.
 *
 * Placement tests are the only DIRECT evidence of inbox placement we have.
 * Everything else in this system infers deliverability from OOO reply rate,
 * which is a proxy: a low OOO rate might mean spam, or might just mean a quiet
 * list. A placement test seeds known inboxes and reports where the mail landed.
 *
 * The proxy holds up. YVF ran two tests the same day, 2026-09-16:
 *   YVF TOP    (high-OOO mailboxes)  97% inbox,  3% spam
 *   YVF BOTTOM (low-OOO mailboxes)   56% inbox, 44% spam
 * Same client, same hour, opposite results — so OOO rank really does track
 * placement. Placement tests confirm it directly instead of inferring it.
 *
 * ONLY GENERIC-CONTENT TESTS COUNT. A test sent with live campaign copy
 * measures the COPY, not the mailbox: spam there might mean bad copy on a
 * perfectly healthy mailbox, and pausing it would be wrong. Tests are treated
 * as generic when "generic" appears in the name (case-insensitive), which
 * matches the existing convention ("test generic").
 *
 * PlusVibe exposes no REST path for placement under /api/v1 — every documented
 * shape 404s. The working route is the MCP tool surface, so this module is
 * written to take an injected fetcher: pass the MCP-backed one in production,
 * or a stub in tests.
 */

const store = require('./db');

// Above this share of spam, a mailbox is not landing and should stop sending.
// 25% is deliberately conservative: placement tests are small (often 4-8 seeds
// per mailbox), so a lower bar would pause healthy mailboxes on chance alone.
// At 25%, YVF BOTTOM (43.8% spam) pauses and YVF TOP (3%) does not.
const SPAM_PAUSE_PCT = 25;

// Never judge a mailbox on fewer than this many seeded sends — the same
// small-sample discipline the OOO side uses.
const MIN_SEEDS = 4;

// How far back to pool runs when judging a mailbox.
//
// A single run gives very few seeds per mailbox: Butterfly's weekly generic
// test sends 90 seeds across 45 senders, so each mailbox gets about 2. Judging
// on the latest run alone would leave every mailbox permanently under
// MIN_SEEDS and nothing would ever flag. Pooling six weeks of runs gives
// roughly 10 seeds per mailbox, which is enough to mean something, while still
// being recent enough to reflect how the mailbox is behaving now.
const POOL_DAYS = 42;

const isGeneric = (name) => /generic/i.test(name || '');

/**
 * Ingest placement results.
 *
 * `api` must provide:
 *   listTests(workspaceId)              -> [{_id, name, status, ...}]
 *   listRuns(workspaceId, parentId)     -> [{_id, name, status, created_at, ...}]
 *   runDetail(workspaceId, runId)       -> {senders: [{id, email, provider}], content, ...}
 *   senderResult(workspaceId, runId, senderAccId) -> [{rec_type, inbox_count, spam_count, ...}]
 */
async function ingestPlacement(db, api, { log = console.error, only = null } = {}) {
  const now = new Date().toISOString();
  const workspaces = db.prepare(`
    SELECT DISTINCT workspace_id, workspace_name FROM mailbox
    WHERE workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state='removed')
      AND (? IS NULL OR workspace_name = ?)
  `).all(only, only);

  const seen = db.prepare(`SELECT test_id FROM placement_run WHERE status='COMPLETED'`)
                 .all().map((r) => r.test_id);
  const done = new Set(seen);

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

  for (const ws of workspaces) {
    let tests;
    try {
      tests = await api.listTests(ws.workspace_id);
    } catch (e) {
      log(`  ${ws.workspace_name}: listTests failed — ${e.message}`);
      continue;
    }

    for (const t of tests || []) {
      if (!isGeneric(t.name)) { skipped++; continue; }

      let runList;
      try {
        runList = await api.listRuns(ws.workspace_id, t._id);
      } catch (e) {
        log(`  ${ws.workspace_name}/${t.name}: listRuns failed — ${e.message}`);
        continue;
      }

      for (const run of runList || []) {
        if (run.status !== 'COMPLETED') continue;
        if (done.has(run._id)) continue;      // already banked, results are final

        let detail;
        try {
          detail = await api.runDetail(ws.workspace_id, run._id);
        } catch (e) {
          log(`  run ${run._id}: detail failed — ${e.message}`);
          continue;
        }

        upRun.run({
          test_id: run._id, parent_id: t._id, workspace_id: ws.workspace_id,
          name: run.name || t.name, status: run.status,
          sent: run.sent ?? null, inbox: run.inbox ?? null,
          inbox_pct: run.inbox_per ?? null, spam_pct: run.spam_per ?? null,
          created_at: run.created_at || null, fetched_at: now,
        });
        runs++;

        for (const s of detail.senders || []) {
          let res;
          try {
            res = await api.senderResult(ws.workspace_id, run._id, s.id);
          } catch (e) {
            log(`  sender ${s.email}: result failed — ${e.message}`);
            continue;
          }
          for (const r of res || []) {
            upRes.run({
              test_id: run._id,
              email: (s.email || '').toLowerCase(),
              rec_type: r.rec_type || 'UNKNOWN',
              sent: r.sent_count || 0,
              inbox: r.inbox_count || 0,
              spam: r.spam_count || 0,
              promotion: r.prom_count || 0,
              missing: r.miss_count || 0,
              tested_at: run.created_at || now,
            });
            rows++;
          }
        }
        log(`  ${ws.workspace_name}: ${run.name} — ${run.inbox_per}% inbox, ${run.spam_per}% spam`);
      }
    }
  }

  const { flagged, orphaned } = applyFlags(db, now);
  log(`placement: ${runs} runs, ${rows} result rows, ${skipped} non-generic tests skipped, `
    + `${flagged} mailboxes flagged`
    + (orphaned ? `, ${orphaned} results for mailboxes no longer in PlusVibe` : ''));
  return { runs, rows, skipped, flagged, orphaned };
}

/**
 * Flag mailboxes whose latest generic test shows them landing in spam.
 *
 * Flagging is recorded here; it does not itself stop PlusVibe sending. Pausing
 * for real is a write to PlusVibe and belongs to Phase 3, where every write is
 * confirmed. The flag is what the dashboard shows and what that step acts on.
 */
function applyFlags(db, now) {
  const latest = db.prepare(`
    SELECT r.email,
           SUM(r.sent)  AS sent,
           SUM(r.spam)  AS spam,
           SUM(r.inbox) AS inbox,
           MAX(r.tested_at) AS tested_at
    FROM placement_result r
    WHERE r.tested_at >= date('now', '-${POOL_DAYS} days')
    GROUP BY r.email
  `).all();

  const flag = db.prepare(`
    UPDATE mailbox SET flagged_reason = ?, flagged_at = ? WHERE email = ?
  `);
  const clear = db.prepare(`
    UPDATE mailbox SET flagged_reason = NULL, flagged_at = NULL WHERE email = ?
  `);

  let n = 0, orphaned = 0;
  const tx = db.transaction(() => {
    for (const m of latest) {
      if ((m.sent || 0) < MIN_SEEDS) continue;       // too small to judge
      const spamPct = m.spam / m.sent * 100;
      if (spamPct >= SPAM_PAUSE_PCT) {
        const res = flag.run(
          `${spamPct.toFixed(0)}% spam in placement test (${m.spam}/${m.sent} seeds)`,
          m.tested_at, m.email
        );
        // A test can name a mailbox that has since been deleted from PlusVibe.
        // Counting the attempt rather than the update would report flags that
        // do not exist anywhere and cannot be acted on.
        if (res.changes > 0) n++; else orphaned++;
      } else {
        // A passing test clears an old flag: the mailbox has recovered.
        clear.run(m.email);
      }
    }
  });
  tx();
  return { flagged: n, orphaned };
}

/**
 * Placement per mailbox, pooled over the recent window.
 *
 * Pooled rather than latest-run-only because one run gives roughly 2 seeds per
 * mailbox — far too few to judge. See POOL_DAYS.
 */
function placementByMailbox(db, { poolDays = POOL_DAYS } = {}) {
  return db.prepare(`
    SELECT r.email,
           m.workspace_name AS client,
           m.domain, m.provider, m.status,
           m.flagged_reason, m.flagged_at, m.paused_at,
           c.lifetime_sends,
           COUNT(DISTINCT r.test_id) AS runs,
           SUM(r.sent)  AS seeds,
           SUM(r.inbox) AS inbox,
           SUM(r.spam)  AS spam,
           ROUND(SUM(r.inbox) * 100.0 / NULLIF(SUM(r.sent),0), 1) AS inbox_pct,
           ROUND(SUM(r.spam)  * 100.0 / NULLIF(SUM(r.sent),0), 1) AS spam_pct,
           MAX(r.tested_at) AS tested_at
    FROM placement_result r
    JOIN mailbox m ON m.email = r.email
    LEFT JOIN mailbox_cumulative c ON c.email = m.email
    WHERE m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state='removed')
      AND r.tested_at >= date('now', '-' || ? || ' days')
    GROUP BY r.email
    ORDER BY spam_pct DESC
  `).all(poolDays);
}

/** Placement split by recipient provider — the basis of ESP matching. */
function placementByRecipient(db) {
  return db.prepare(`
    SELECT r.rec_type,
           m.provider AS sender_provider,
           SUM(r.sent)  AS seeds,
           SUM(r.inbox) AS inbox,
           SUM(r.spam)  AS spam,
           ROUND(SUM(r.inbox) * 100.0 / NULLIF(SUM(r.sent),0), 1) AS inbox_pct
    FROM placement_result r
    JOIN mailbox m ON m.email = r.email
    GROUP BY r.rec_type, m.provider
    HAVING seeds > 0
    ORDER BY inbox_pct ASC
  `).all();
}

/** Runs we have stored, newest first. */
function placementRuns(db, limit = 30) {
  return db.prepare(`
    SELECT * FROM placement_run ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  ingestPlacement, applyFlags, placementByMailbox, placementByRecipient,
  placementRuns, isGeneric, SPAM_PAUSE_PCT, MIN_SEEDS, POOL_DAYS,
};
