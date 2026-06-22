-- Denormalized, fully-merged mailbox dataset that backs the admin-new Mailboxes
-- page (full parity with admin-legacy). Populated by the independent sync in
-- lib/mailbox-sync.ts (PlusVibe accounts + mailbox_meta + mailbox_pricing +
-- domain_health + email_events, all merged + computed). admin-new's
-- /api/mailboxes reads ONLY this table — no runtime PlusVibe calls, no
-- dependency on admin-legacy.
--
-- Run once against the ottaly Postgres:  psql "$DATABASE_URL" -f mailbox-full-schema.sql

CREATE TABLE IF NOT EXISTS mailbox_full (
  email               TEXT PRIMARY KEY,
  account_id          TEXT,
  domain              TEXT,
  workspace_id        TEXT,
  workspace_name      TEXT,
  -- PlusVibe live fields
  status              TEXT,            -- ACTIVE / PAUSED / disconnected states
  warmup_status       TEXT,
  provider            TEXT,            -- gmail / outlook / smtp host string
  name                TEXT,
  daily_limit         INTEGER,
  sending_gap         INTEGER,
  warmup_limit        INTEGER,
  warmup_reply_rate   NUMERIC,
  warmup_enabled_at   TIMESTAMPTZ,
  campaigns_count     INTEGER DEFAULT 0,
  campaign_ids        JSONB   DEFAULT '[]',
  -- meta overrides (mailbox_meta)
  type                TEXT,            -- google / microsoft / smtp (manual or auto)
  type_auto           TEXT,            -- auto-detected from provider
  supplier            TEXT,            -- Maildoso / Mithun / Winnr / Inboxing / null
  notes               TEXT,
  billing_start_date  DATE,
  billing_day         INTEGER,
  ignored_at          TIMESTAMPTZ,
  unit_cost           NUMERIC,         -- from mailbox_pricing (supplier × type)
  -- performance (email_events + campaign attribution)
  attributed_sent     INTEGER DEFAULT 0,
  attributed_replies  INTEGER DEFAULT 0,
  attributed_bounces  INTEGER DEFAULT 0,
  reply_rate          NUMERIC DEFAULT 0,   -- 0..1
  bounce_rate         NUMERIC DEFAULT 0,   -- 0..1
  -- auth / domain health (domain_health)
  auth                JSONB,           -- { spf_present, spf_strict, dkim_present, dkim_selector, dmarc_present, dmarc_policy, ... }
  blacklist_count     INTEGER DEFAULT 0,
  domain_score        INTEGER,
  domain_notes        TEXT,
  domain_status       TEXT,
  -- computed
  attention           JSONB DEFAULT '[]',  -- [{ level, msg }]
  synced_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mailbox_full_supplier ON mailbox_full (supplier);
CREATE INDEX IF NOT EXISTS idx_mailbox_full_type     ON mailbox_full (type);
CREATE INDEX IF NOT EXISTS idx_mailbox_full_workspace ON mailbox_full (workspace_name);
CREATE INDEX IF NOT EXISTS idx_mailbox_full_synced   ON mailbox_full (synced_at);

-- Tracks the last sync run for the "Not yet synced" / last-refresh UI.
CREATE TABLE IF NOT EXISTS mailbox_sync_state (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  last_run    TIMESTAMPTZ,
  running     BOOLEAN DEFAULT FALSE,
  last_error  TEXT,
  count       INTEGER,
  CHECK (id = 1)
);
INSERT INTO mailbox_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Daily per-group (supplier or type) snapshot for trend charts. One row per
-- (dimension, key, day); the sync upserts so multiple syncs in a day just
-- refresh today's row. History accumulates one day at a time.
CREATE TABLE IF NOT EXISTS mailbox_supplier_daily (
  day         DATE NOT NULL,
  dimension   TEXT NOT NULL,         -- 'supplier' | 'type'
  key         TEXT NOT NULL,         -- e.g. 'Maildoso' / 'google' / 'Unassigned'
  count       INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 0,
  total_sent  INTEGER DEFAULT 0,
  reply_rate  NUMERIC DEFAULT 0,
  bounce_rate NUMERIC DEFAULT 0,
  warmup_pct  INTEGER DEFAULT 0,
  -- raw daily counts so cards can show RR-human vs RR+OOO and recompute rates
  total_replies   INTEGER DEFAULT 0,   -- all replies (incl. OOO/auto)
  total_ooo       INTEGER DEFAULT 0,   -- OOO / automatic replies
  total_bounces   INTEGER DEFAULT 0,
  total_contacted INTEGER DEFAULT 0,
  PRIMARY KEY (day, dimension, key)
);
ALTER TABLE mailbox_supplier_daily ADD COLUMN IF NOT EXISTS total_replies   INTEGER DEFAULT 0;
ALTER TABLE mailbox_supplier_daily ADD COLUMN IF NOT EXISTS total_ooo       INTEGER DEFAULT 0;
ALTER TABLE mailbox_supplier_daily ADD COLUMN IF NOT EXISTS total_bounces   INTEGER DEFAULT 0;
ALTER TABLE mailbox_supplier_daily ADD COLUMN IF NOT EXISTS total_contacted INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mbsd_dim_key_day ON mailbox_supplier_daily (dimension, key, day);

