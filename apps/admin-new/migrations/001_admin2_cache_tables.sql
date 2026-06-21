-- admin-2.0 cache tables (additive, idempotent). Approved by Jesse 2026-06-20.
-- These are read-only from the web app; filled by the client-portal reconciler.
-- Nothing existing is altered or dropped.

-- Per-workspace action/health snapshot — feeds Actions + Mailboxes summary + home KPIs.
-- Replaces the 6-call live PlusVibe fan-out with one cached read.
CREATE TABLE IF NOT EXISTS client_actions_cache (
  workspace_id     text PRIMARY KEY,
  workspace_name   text,
  sent             integer     NOT NULL DEFAULT 0,
  replies          integer     NOT NULL DEFAULT 0,   -- human replies (excludes OOO + warmup)
  ooo_replies      integer     NOT NULL DEFAULT 0,   -- OOO/automatic replies
  bounces          integer     NOT NULL DEFAULT 0,
  leads            integer     NOT NULL DEFAULT 0,
  reply_rate       numeric,                          -- Human RR = replies / sent
  all_reply_rate   numeric,                          -- Reply Rate = (replies + ooo) / sent
  bounce_rate      numeric,
  leads_left_pct   numeric,                 -- % of campaign leads remaining
  active_campaigns integer     NOT NULL DEFAULT 0,
  paused_campaigns integer     NOT NULL DEFAULT 0,
  warmup_pct       numeric,
  last_send_date   date,
  status           text,                    -- ok | not_sending | need_data
  flagged          boolean     NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now()
);

-- Per-mailbox per-day warmup volume + health — feeds Warmup.
CREATE TABLE IF NOT EXISTS warmup_daily_stats (
  email_acc_id   text NOT NULL,
  workspace_id   text NOT NULL,            -- PV workspace_id (canonical join key)
  email          text,
  snapshot_date  date NOT NULL,
  warmup_score   integer,
  warmup_sent    integer NOT NULL DEFAULT 0,
  warmup_landed  integer NOT NULL DEFAULT 0,
  health         text,                     -- healthy | low_score | bouncing | disabled | unknown
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_acc_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_warmup_daily_ws   ON warmup_daily_stats (workspace_id);
CREATE INDEX IF NOT EXISTS idx_warmup_daily_date ON warmup_daily_stats (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_actions_cache_status ON client_actions_cache (status);
