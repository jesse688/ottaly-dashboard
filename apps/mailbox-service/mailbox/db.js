/**
 * Mailbox system storage.
 *
 * SQLite locally, Postgres in admin-new. The schema is deliberately written in
 * the subset both accept so the port is a connection change, not a rewrite.
 *
 * Two rules from MAILBOX_SYSTEM_PLAN.md are enforced here rather than left to
 * callers:
 *   1. Mailboxes are keyed by EMAIL, not PlusVibe account id. A deleted and
 *      re-added mailbox gets a new id but keeps its sending history, so keying
 *      on id silently splits one mailbox into two.
 *   2. Daily rows are immutable once banked. Cumulative sends are derived by
 *      stitching 90-day windows and cannot be recovered from PlusVibe later,
 *      so a row that exists is never recomputed, only appended to.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.MAILBOX_DB ||
  path.join(__dirname, '..', 'data', 'mailbox.db');

const SCHEMA = `
-- One row per mailbox we have ever seen, keyed by email.
CREATE TABLE IF NOT EXISTS mailbox (
  email           TEXT PRIMARY KEY,
  pv_id           TEXT,
  workspace_id    TEXT,
  workspace_name  TEXT,
  domain          TEXT,
  provider        TEXT,
  status          TEXT,
  warmup_status   TEXT,
  in_recovery     INTEGER DEFAULT 0,
  created_at      TEXT,
  daily_limit     INTEGER,
  auto_pause      TEXT,
  rand_pct        INTEGER,
  first_seen      TEXT,
  last_seen       TEXT,
  retired_at      TEXT,
  -- Set when a placement test shows this mailbox landing in spam. Kept
  -- separate from PlusVibe's own status so we can tell "we paused this" from
  -- "PlusVibe reports a problem", and so clearing the flag is our decision.
  flagged_reason  TEXT,
  flagged_at      TEXT,
  paused_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_mailbox_ws ON mailbox(workspace_name);
CREATE INDEX IF NOT EXISTS idx_mailbox_dom ON mailbox(domain);

-- Per-mailbox per-day activity. Immutable once written.
CREATE TABLE IF NOT EXISTS mailbox_daily (
  email       TEXT NOT NULL,
  date        TEXT NOT NULL,
  sent        INTEGER DEFAULT 0,
  ooo         INTEGER DEFAULT 0,
  replies     INTEGER DEFAULT 0,
  positive    INTEGER DEFAULT 0,
  contacted   INTEGER DEFAULT 0,
  bounce      INTEGER DEFAULT 0,
  PRIMARY KEY (email, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON mailbox_daily(date);

-- Derived lifetime totals. Rebuilt from mailbox_daily, never from PlusVibe.
CREATE TABLE IF NOT EXISTS mailbox_cumulative (
  email             TEXT PRIMARY KEY,
  lifetime_sends    INTEGER DEFAULT 0,
  lifetime_ooo      INTEGER DEFAULT 0,
  lifetime_contacted INTEGER DEFAULT 0,
  sends_since_rest  INTEGER DEFAULT 0,
  last_rest_end     TEXT,
  covered_from      TEXT,
  covered_to        TEXT,
  as_of             TEXT
);

-- Per-mailbox per-window header totals.
--
-- total_contacted_count exists only on the bulk-stats header, never in the
-- daily chart, and is what every PlusVibe rate divides by. Summing the daily
-- proxy would drift from what the PlusVibe UI shows, so the exact header value
-- is banked per window and rates are computed from these rows.
CREATE TABLE IF NOT EXISTS mailbox_window (
  email       TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  sent        INTEGER DEFAULT 0,
  ooo         INTEGER DEFAULT 0,
  replies     INTEGER DEFAULT 0,
  positive    INTEGER DEFAULT 0,
  contacted   INTEGER DEFAULT 0,
  bounce      INTEGER DEFAULT 0,
  recipient_bounce INTEGER DEFAULT 0,
  sender_bounce    INTEGER DEFAULT 0,
  PRIMARY KEY (email, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_win_email ON mailbox_window(email);

-- Which 90-day windows have been banked, so a backfill never repeats work.
CREATE TABLE IF NOT EXISTS ingest_window (
  workspace_id  TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  rows_written  INTEGER,
  fetched_at    TEXT,
  PRIMARY KEY (workspace_id, start_date, end_date)
);

-- Bounces, one row per bounced lead, with the cause read from the message.
--
-- The text is stored, not just the classification: a rule that turns out to be
-- wrong can be re-run over history, and an unclassified bounce is evidence of
-- a missing rule rather than a non-event.
CREATE TABLE IF NOT EXISTS bounce_event (
  lead_id      TEXT PRIMARY KEY,
  email        TEXT,              -- the SENDING mailbox
  workspace    TEXT,
  recipient    TEXT,
  bounced_at   TEXT,
  bounce_type  TEXT,              -- PV's SENDER / RECIPIENT, too coarse to act on
  status_code  TEXT,              -- e.g. 5.7.233
  cause        TEXT,              -- our classification key
  action       TEXT,              -- what it implies we should do
  bounce_msg   TEXT
);
CREATE INDEX IF NOT EXISTS idx_bounce_email ON bounce_event(email);
CREATE INDEX IF NOT EXISTS idx_bounce_when  ON bounce_event(bounced_at);
CREATE INDEX IF NOT EXISTS idx_bounce_cause ON bounce_event(cause);

-- Placement test results, per mailbox per run.
--
-- This is the only DIRECT evidence of inbox placement we have. Everything else
-- in this system infers deliverability from OOO reply rate, which is a proxy:
-- a mailbox with a low OOO rate might be in spam, or might just have a quiet
-- list. A placement test seeds known inboxes and reports where the mail landed,
-- so spam is measured rather than guessed.
--
-- Stored per recipient provider (GOOGLE / MICROSOFT / …) because where a
-- mailbox lands differs by recipient — that split is the whole basis of the
-- ESP matching work.
CREATE TABLE IF NOT EXISTS placement_result (
  test_id     TEXT NOT NULL,      -- the run, not the parent test
  email       TEXT NOT NULL,      -- sending mailbox
  rec_type    TEXT NOT NULL,      -- recipient provider
  sent        INTEGER DEFAULT 0,
  inbox       INTEGER DEFAULT 0,
  spam        INTEGER DEFAULT 0,
  promotion   INTEGER DEFAULT 0,
  missing     INTEGER DEFAULT 0,
  tested_at   TEXT,
  PRIMARY KEY (test_id, email, rec_type)
);
CREATE INDEX IF NOT EXISTS idx_pl_email ON placement_result(email);
CREATE INDEX IF NOT EXISTS idx_pl_when  ON placement_result(tested_at);

-- One row per placement run, so repeated ingests skip completed work.
CREATE TABLE IF NOT EXISTS placement_run (
  test_id       TEXT PRIMARY KEY,
  parent_id     TEXT,
  workspace_id  TEXT,
  name          TEXT,
  status        TEXT,
  sent          INTEGER,
  inbox         INTEGER,
  inbox_pct     REAL,
  spam_pct      REAL,
  created_at    TEXT,
  fetched_at    TEXT
);

-- Client state. A workspace with no row here is active.
--
-- Three states, because "not sending right now" and "gone" are different
-- things and collapsing them loses information:
--   active   normal. Appears everywhere, generates actions.
--   paused   still our client, temporarily not sending. Stays visible and
--            keeps ingesting, but raises no actions -- a paused client is not
--            failing, so runway and underperformance warnings would be noise.
--   removed  no longer a client. Hidden from every view and from estate
--            totals. History is kept, never deleted: Hayes & Co dying at 369
--            sends per mailbox is evidence we still want.
CREATE TABLE IF NOT EXISTS client_state (
  workspace_name TEXT PRIMARY KEY,
  state          TEXT NOT NULL DEFAULT 'active',
  note           TEXT,
  changed_at     TEXT
);

-- Run log, so a failed nightly job is visible rather than silent.
CREATE TABLE IF NOT EXISTS ingest_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT,
  finished_at TEXT,
  kind        TEXT,
  workspaces  INTEGER,
  mailboxes   INTEGER,
  api_calls   INTEGER,
  errors      INTEGER,
  note        TEXT
);
`;

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
 * add a column to a table that already exists, so new ones are applied here.
 */
const ADDED_COLUMNS = [
  ['mailbox', 'flagged_reason', 'TEXT'],
  ['mailbox', 'flagged_at', 'TEXT'],
  ['mailbox', 'paused_at', 'TEXT'],
];

function open() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  for (const [table, col, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all()
                  .some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  return db;
}

/** Upsert the mailbox roster. Existing rows keep first_seen. */
function upsertMailboxes(db, rows, now) {
  const stmt = db.prepare(`
    INSERT INTO mailbox (email, pv_id, workspace_id, workspace_name, domain,
      provider, status, warmup_status, in_recovery, created_at, daily_limit,
      auto_pause, rand_pct, first_seen, last_seen)
    VALUES (@email, @pv_id, @workspace_id, @workspace_name, @domain,
      @provider, @status, @warmup_status, @in_recovery, @created_at, @daily_limit,
      @auto_pause, @rand_pct, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      pv_id=excluded.pv_id,
      workspace_id=excluded.workspace_id,
      workspace_name=excluded.workspace_name,
      provider=excluded.provider,
      status=excluded.status,
      warmup_status=excluded.warmup_status,
      in_recovery=excluded.in_recovery,
      daily_limit=excluded.daily_limit,
      auto_pause=excluded.auto_pause,
      rand_pct=excluded.rand_pct,
      last_seen=excluded.last_seen,
      retired_at=NULL
  `);
  const tx = db.transaction((list) => {
    for (const r of list) stmt.run({ ...r, now });
  });
  tx(rows);
}

/**
 * Bank daily rows. Existing (email, date) pairs are left alone — a banked day
 * is never rewritten, because the 90-day window that produced it may no longer
 * be reachable.
 */
function insertDaily(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO mailbox_daily (email, date, sent, ooo, replies, positive, contacted, bounce)
    VALUES (@email, @date, @sent, @ooo, @replies, @positive, @contacted, @bounce)
    ON CONFLICT(email, date) DO NOTHING
  `);
  const tx = db.transaction((list) => {
    for (const r of list) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}

/** Bank per-window header totals. Rewritable: the most recent window moves. */
function insertWindows(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO mailbox_window (email, start_date, end_date, sent, ooo, replies,
      positive, contacted, bounce, recipient_bounce, sender_bounce)
    VALUES (@email, @start_date, @end_date, @sent, @ooo, @replies,
      @positive, @contacted, @bounce, @recipient_bounce, @sender_bounce)
    ON CONFLICT(email, start_date, end_date) DO UPDATE SET
      sent=excluded.sent, ooo=excluded.ooo, replies=excluded.replies,
      positive=excluded.positive, contacted=excluded.contacted,
      bounce=excluded.bounce, recipient_bounce=excluded.recipient_bounce,
      sender_bounce=excluded.sender_bounce
  `);
  const tx = db.transaction((list) => { for (const r of list) stmt.run(r); });
  tx(rows);
  return rows.length;
}

function markWindow(db, workspace_id, start_date, end_date, rows_written, now) {
  db.prepare(`
    INSERT INTO ingest_window (workspace_id, start_date, end_date, rows_written, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, start_date, end_date) DO UPDATE SET
      rows_written=excluded.rows_written, fetched_at=excluded.fetched_at
  `).run(workspace_id, start_date, end_date, rows_written, now);
}

function haveWindow(db, workspace_id, start_date, end_date) {
  return !!db.prepare(`
    SELECT 1 FROM ingest_window
    WHERE workspace_id=? AND start_date=? AND end_date=?
  `).get(workspace_id, start_date, end_date);
}

/**
 * Recompute lifetime totals from banked daily rows.
 *
 * sends_since_rest resets after any gap of >= restGapDays with no sends. The
 * plan's §5.1 open question is whether this predicts decline better than raw
 * lifetime; storing both is what makes that testable.
 */
function rebuildCumulative(db, now, restGapDays = 7) {
  const emails = db.prepare(`SELECT DISTINCT email FROM mailbox_daily`).all();
  const getDays = db.prepare(`
    SELECT date, sent, ooo, contacted FROM mailbox_daily
    WHERE email=? ORDER BY date ASC
  `);
  const up = db.prepare(`
    INSERT INTO mailbox_cumulative (email, lifetime_sends, lifetime_ooo,
      lifetime_contacted, sends_since_rest, last_rest_end, covered_from, covered_to, as_of)
    VALUES (@email, @sends, @ooo, @contacted, @since, @rest, @from, @to, @now)
    ON CONFLICT(email) DO UPDATE SET
      lifetime_sends=excluded.lifetime_sends,
      lifetime_ooo=excluded.lifetime_ooo,
      lifetime_contacted=excluded.lifetime_contacted,
      sends_since_rest=excluded.sends_since_rest,
      last_rest_end=excluded.last_rest_end,
      covered_from=excluded.covered_from,
      covered_to=excluded.covered_to,
      as_of=excluded.as_of
  `);
  // Lifetime contacted comes from banked window headers, not the daily proxy,
  // so rates match what PlusVibe's own UI reports.
  const getWin = db.prepare(`
    SELECT COALESCE(SUM(contacted),0) AS c, COALESCE(SUM(ooo),0) AS o
    FROM mailbox_window WHERE email=?
  `);
  const tx = db.transaction(() => {
    for (const { email } of emails) {
      const days = getDays.all(email);
      const w = getWin.get(email) || { c: 0, o: 0 };
      let sends = 0, since = 0, rest = null;
      let ooo = w.o, contacted = w.c;
      let lastSend = null;
      for (const d of days) {
        sends += d.sent;
        if (d.sent > 0) {
          if (lastSend) {
            const gap = (new Date(d.date) - new Date(lastSend)) / 86400000;
            if (gap >= restGapDays) { since = 0; rest = d.date; }
          }
          since += d.sent;
          lastSend = d.date;
        }
      }
      up.run({
        email, sends, ooo, contacted, since, rest, now,
        from: days.length ? days[0].date : null,
        to: days.length ? days[days.length - 1].date : null,
      });
    }
  });
  tx();
  return emails.length;
}

/** Every client's state, as {name: {state, note, changed_at}}. */
function clientStates(db) {
  const out = {};
  for (const r of db.prepare(`SELECT * FROM client_state`).all()) {
    out[r.workspace_name] = r;
  }
  return out;
}

/** Set a client's state. 'active' clears the row so the default applies. */
function setClientState(db, name, state, note, now) {
  if (!['active', 'paused', 'removed'].includes(state)) {
    throw new Error(`unknown client state: ${state}`);
  }
  if (state === 'active') {
    db.prepare(`DELETE FROM client_state WHERE workspace_name = ?`).run(name);
    return { workspace_name: name, state: 'active' };
  }
  db.prepare(`
    INSERT INTO client_state (workspace_name, state, note, changed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_name) DO UPDATE SET
      state=excluded.state, note=excluded.note, changed_at=excluded.changed_at
  `).run(name, state, note || null, now);
  return { workspace_name: name, state, note, changed_at: now };
}

/** Workspace names in a given state. */
function clientsInState(db, state) {
  return db.prepare(`SELECT workspace_name FROM client_state WHERE state = ?`)
           .all(state).map((r) => r.workspace_name);
}

function startRun(db, kind, now) {
  const r = db.prepare(
    `INSERT INTO ingest_run (started_at, kind) VALUES (?, ?)`
  ).run(now, kind);
  return r.lastInsertRowid;
}

function finishRun(db, id, stats, now) {
  db.prepare(`
    UPDATE ingest_run SET finished_at=?, workspaces=?, mailboxes=?,
      api_calls=?, errors=?, note=? WHERE id=?
  `).run(now, stats.workspaces, stats.mailboxes, stats.apiCalls,
         stats.errors, stats.note || null, id);
}

module.exports = {
  DB_PATH, open, upsertMailboxes, insertDaily, insertWindows, markWindow,
  haveWindow, rebuildCumulative, startRun, finishRun,
  clientStates, setClientState, clientsInState,
};
