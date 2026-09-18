-- Mailbox health system (additive, idempotent). Approved by Jesse 2026-09-18.
-- Nothing existing is altered or dropped.
--
-- Four new tables plus three columns on mailbox_full. Deliberately NOT a full
-- mailbox model: mailbox_full already carries email, workspace, domain,
-- provider, status, daily_limit, supplier, tags and auth, and email_events
-- already stores every bounce with its message text. Both are reused.
--
-- Everything here is prefixed mbx_ because mailbox_full, mailbox_meta and
-- mailbox_supplier_daily already exist; a bare `mailbox` table beside them
-- would be genuinely confusing to read later.

-- ── mailbox_full additions ────────────────────────────────────────────────
-- Set when a placement test shows a mailbox landing in spam, and when we stop
-- its cold sending. Kept separate from PlusVibe's own `status` because PV
-- reports a mailbox on daily_limit 0 as "Active" (its UI shows sends as
-- "12/0" — 12 warmup, 0 campaign), so status cannot tell you whether we paused
-- something. Paused is derived from the limit; these record why and when.
ALTER TABLE mailbox_full ADD COLUMN IF NOT EXISTS flagged_reason text;
ALTER TABLE mailbox_full ADD COLUMN IF NOT EXISTS flagged_at     timestamptz;
ALTER TABLE mailbox_full ADD COLUMN IF NOT EXISTS paused_at      timestamptz;

-- ── mbx_daily ─────────────────────────────────────────────────────────────
-- Per-mailbox per-day activity. Immutable once written.
--
-- mailbox_supplier_daily aggregates by supplier or type, which cannot give a
-- per-mailbox lifetime total. This can, and it is the only way to get one:
-- PlusVibe has no lifetime send count and rejects any date range over 90 days
-- ("end_date: Date range must not exceed 90 days"), so cumulative sends are
-- stitched from windows. A day that is not banked before it falls out of
-- PlusVibe's reach cannot be recovered.
CREATE TABLE IF NOT EXISTS mbx_daily (
  email      text    NOT NULL,
  date       date    NOT NULL,
  sent       integer NOT NULL DEFAULT 0,
  ooo        integer NOT NULL DEFAULT 0,   -- out-of-office replies
  replies    integer NOT NULL DEFAULT 0,   -- human replies
  positive   integer NOT NULL DEFAULT 0,
  contacted  integer NOT NULL DEFAULT 0,   -- new leads contacted that day
  bounce     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (email, date)
);
CREATE INDEX IF NOT EXISTS idx_mbx_daily_date ON mbx_daily (date);

-- ── mbx_window ────────────────────────────────────────────────────────────
-- PlusVibe's own 90-day header totals, per mailbox per window.
--
-- Exists because total_contacted_count appears ONLY on the bulk-stats header,
-- never in the daily chart, and every PlusVibe rate divides by it. Summing the
-- daily proxy (total_new_lead_contacted_count) drifts from what the PlusVibe
-- UI shows — measured 395 vs 394 on one mailbox, 494 vs 489 on another. Rates
-- are computed from these rows so our numbers match theirs.
CREATE TABLE IF NOT EXISTS mbx_window (
  email            text    NOT NULL,
  start_date       date    NOT NULL,
  end_date         date    NOT NULL,
  sent             integer NOT NULL DEFAULT 0,
  ooo              integer NOT NULL DEFAULT 0,
  replies          integer NOT NULL DEFAULT 0,
  positive         integer NOT NULL DEFAULT 0,
  contacted        integer NOT NULL DEFAULT 0,   -- the header value; the denominator
  bounce           integer NOT NULL DEFAULT 0,
  recipient_bounce integer NOT NULL DEFAULT 0,
  sender_bounce    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (email, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_mbx_window_email ON mbx_window (email);

-- ── mbx_placement ─────────────────────────────────────────────────────────
-- Placement test results, per mailbox per run per recipient provider.
--
-- The only DIRECT evidence of inbox placement we have. Everything else infers
-- deliverability from OOO reply rate, which is a proxy: a low rate might mean
-- spam, or might just mean a quiet list. The proxy holds up — YVF ran two
-- tests in the same hour on 2026-09-16, one on high-OOO mailboxes (97% inbox)
-- and one on low-OOO (56% inbox, 44% spam) — but this measures it rather than
-- inferring it.
--
-- Split by recipient provider because where a mailbox lands differs by
-- recipient, which is the whole basis of the ESP matching work.
CREATE TABLE IF NOT EXISTS mbx_placement (
  test_id    text NOT NULL,          -- the RUN, not the parent test
  email      text NOT NULL,          -- the sending mailbox
  rec_type   text NOT NULL,          -- recipient provider: GOOGLE / MICROSOFT / ...
  sent       integer NOT NULL DEFAULT 0,
  inbox      integer NOT NULL DEFAULT 0,
  spam       integer NOT NULL DEFAULT 0,
  promotion  integer NOT NULL DEFAULT 0,
  missing    integer NOT NULL DEFAULT 0,
  tested_at  timestamptz,
  PRIMARY KEY (test_id, email, rec_type)
);
CREATE INDEX IF NOT EXISTS idx_mbx_placement_email ON mbx_placement (email);
CREATE INDEX IF NOT EXISTS idx_mbx_placement_when  ON mbx_placement (tested_at);

-- One row per placement run, so a repeated ingest skips completed work.
CREATE TABLE IF NOT EXISTS mbx_placement_run (
  test_id      text PRIMARY KEY,
  parent_id    text,
  workspace_id text,
  name         text,
  status       text,
  sent         integer,
  inbox        integer,
  inbox_pct    numeric,
  spam_pct     numeric,
  created_at   timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

-- ── mbx_client_state ──────────────────────────────────────────────────────
-- A workspace with no row here is active.
--
-- Three states, because "not sending right now" and "gone" are different and
-- collapsing them loses information:
--   active   normal
--   paused   still ours, temporarily not sending. Stays visible in totals but
--            raises no actions — a client who is not sending cannot be failing
--   removed  gone. Hidden from every view; history is KEPT, never deleted
--            (Hayes & Co burning out at 369 sends/mbx is evidence worth having)
CREATE TABLE IF NOT EXISTS mbx_client_state (
  workspace_name text PRIMARY KEY,
  state          text NOT NULL DEFAULT 'active',
  note           text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbx_client_state_state_chk CHECK (state IN ('active','paused','removed'))
);

-- ── mbx_ingest_run ────────────────────────────────────────────────────────
-- Run log, so a silently failing job is visible rather than invisible. Reports
-- the last FINISHED run: a run killed partway leaves finished_at null, and
-- showing that as "the last ingest" reads as "no data" while the store is in
-- fact fully populated.
CREATE TABLE IF NOT EXISTS mbx_ingest_run (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  kind        text,
  workspaces  integer,
  mailboxes   integer,
  api_calls   integer,
  errors      integer,
  note        text
);
CREATE INDEX IF NOT EXISTS idx_mbx_ingest_run_finished ON mbx_ingest_run (finished_at DESC);
