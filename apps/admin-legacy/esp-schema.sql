-- ESP Sync Schema
-- Tables are named generically (esp_*) so they work with any email service provider.
-- Each row has a `source` column ('plusvibe', 'emailbison', etc) and a `raw` JSONB
-- column storing the full API response — so no data is ever lost when we add fields.

-- Workspaces / accounts
CREATE TABLE IF NOT EXISTS esp_workspaces (
  id            text        NOT NULL,
  source        text        NOT NULL DEFAULT 'plusvibe',
  name          text        NOT NULL,
  raw           jsonb       NOT NULL DEFAULT '{}',
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, source)
);

-- Campaigns
CREATE TABLE IF NOT EXISTS esp_campaigns (
  id              text        NOT NULL,
  source          text        NOT NULL DEFAULT 'plusvibe',
  workspace_id    text        NOT NULL,
  name            text        NOT NULL,
  status          text,
  campaign_type   text,
  lead_count      integer,
  sent_count      integer,
  replied_count   integer,
  bounced_count   integer,
  positive_reply_count integer,
  reply_rate      numeric,
  daily_limit     integer,
  last_lead_sent  timestamptz,
  last_lead_replied timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  raw             jsonb       NOT NULL DEFAULT '{}',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, source)
);

CREATE INDEX IF NOT EXISTS idx_esp_campaigns_workspace ON esp_campaigns(workspace_id, source);
CREATE INDEX IF NOT EXISTS idx_esp_campaigns_status ON esp_campaigns(status);

-- Email accounts
CREATE TABLE IF NOT EXISTS esp_email_accounts (
  id              text        NOT NULL,
  source          text        NOT NULL DEFAULT 'plusvibe',
  workspace_id    text        NOT NULL,
  email           text        NOT NULL,
  status          text,
  warmup_enabled  boolean,
  warmup_score    integer,
  daily_limit     integer,
  sent_today      integer,
  supplier        text,
  tags            jsonb       NOT NULL DEFAULT '[]',
  raw             jsonb       NOT NULL DEFAULT '{}',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, source)
);

CREATE INDEX IF NOT EXISTS idx_esp_email_accounts_workspace ON esp_email_accounts(workspace_id, source);
CREATE INDEX IF NOT EXISTS idx_esp_email_accounts_status ON esp_email_accounts(status);

-- Leads (replied/interested — not all contacts, just ESP-tracked leads)
CREATE TABLE IF NOT EXISTS esp_leads (
  id              text        NOT NULL,
  source          text        NOT NULL DEFAULT 'plusvibe',
  workspace_id    text        NOT NULL,
  campaign_id     text,
  email           text        NOT NULL,
  first_name      text,
  last_name       text,
  company_name    text,
  status          text,
  label           text,
  created_at      timestamptz,
  updated_at      timestamptz,
  raw             jsonb       NOT NULL DEFAULT '{}',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, source)
);

CREATE INDEX IF NOT EXISTS idx_esp_leads_workspace ON esp_leads(workspace_id, source);
CREATE INDEX IF NOT EXISTS idx_esp_leads_campaign ON esp_leads(campaign_id, source);
CREATE INDEX IF NOT EXISTS idx_esp_leads_status ON esp_leads(status);

-- Analytics snapshots (daily, per workspace)
CREATE TABLE IF NOT EXISTS esp_analytics (
  id              text        NOT NULL,  -- workspace_id + date
  source          text        NOT NULL DEFAULT 'plusvibe',
  workspace_id    text        NOT NULL,
  date            date        NOT NULL,
  sent            integer     NOT NULL DEFAULT 0,
  opens           integer     NOT NULL DEFAULT 0,
  replies         integer     NOT NULL DEFAULT 0,
  bounces         integer     NOT NULL DEFAULT 0,
  new_leads       integer     NOT NULL DEFAULT 0,
  raw             jsonb       NOT NULL DEFAULT '{}',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, source)
);

CREATE INDEX IF NOT EXISTS idx_esp_analytics_workspace ON esp_analytics(workspace_id, source, date);

-- Sync log — track when each workspace was last synced and any errors
CREATE TABLE IF NOT EXISTS esp_sync_log (
  id              serial      PRIMARY KEY,
  source          text        NOT NULL DEFAULT 'plusvibe',
  workspace_id    text        NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text        NOT NULL DEFAULT 'running', -- running, success, error
  campaigns_synced integer,
  accounts_synced  integer,
  leads_synced     integer,
  error           text,
  synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esp_sync_log_workspace ON esp_sync_log(workspace_id, source);
