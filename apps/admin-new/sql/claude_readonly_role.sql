-- Claude MCP read-only access
--
-- Creates a limited Postgres role for the Claude MCP server.
-- The role can read a small set of views ONLY. It has no access to any
-- base table, so finance data cannot be reached even by a future bug or
-- a newly added tool.
--
-- Shared-account note: every director and CM uses the same Claude login,
-- so there is no per-person permission here by design. Finance is blocked
-- for everyone, without exception.
--
-- REVIEW BEFORE RUNNING. Step 0 is a check, not a change - run it first.

-- ---------------------------------------------------------------------
-- STEP 0. Verify no money column sneaks into the views.
-- Run this on its own and read the output before anything else.
-- It lists every money-ish column on the tables we are about to expose.
-- Anything printed here MUST be absent from the view definitions below.
-- ---------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'revenue_leads','esp_leads','esp_campaigns','workspace_stats','contacts',
    'domain_health','mailbox_meta','combo_history','client_health_snapshots',
    'daily_intelligence_logs','performance_patterns','diagnostic_signals',
    'diagnostic_external_factors','perf_cache_daily','esp_workspaces'
  )
  AND (
    column_name ~* 'price|cost|revenue|amount|balance|invoice|bill|charge|paid|salary|commission|payslip|margin|spend|fee|budget'
  )
ORDER BY table_name, column_name;

-- ---------------------------------------------------------------------
-- STEP 1. The role.
-- Replace the password before running. Store it in a password manager;
-- it goes in the MCP server's env as CLAUDE_DATABASE_URL.
-- ---------------------------------------------------------------------
CREATE ROLE claude_ro WITH LOGIN PASSWORD 'REPLACE_ME_WITH_A_LONG_RANDOM_PASSWORD';

-- No inherited privileges, no table creation, no future-table access.
REVOKE ALL ON SCHEMA public FROM claude_ro;
GRANT USAGE ON SCHEMA public TO claude_ro;

-- Explicitly ensure the role gets nothing automatically in future.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM claude_ro;

-- ---------------------------------------------------------------------
-- STEP 2. The views. Columns are listed one by one on purpose.
-- Never use SELECT * here - that is how a money column leaks in later.
--
-- revenue_leads is the important one: it holds both the lead data we want
-- and the lead_price we must not expose. lead_price is omitted.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW claude_leads AS
SELECT workspace_id,
       workspace_name,
       lead_email,
       first_name,
       last_name,
       campaign,
       date,
       label,
       updated_at
FROM revenue_leads
WHERE label NOT IN ('UNSUBSCRIBED', 'BOUNCED');
-- NOTE: lead_price deliberately excluded.

CREATE OR REPLACE VIEW claude_workspace_stats AS
SELECT *
FROM workspace_stats;
-- Verified by STEP 0: confirm workspace_stats has no money column.
-- If STEP 0 printed any row for workspace_stats, replace this SELECT *
-- with an explicit column list omitting those columns.

CREATE OR REPLACE VIEW claude_campaigns AS
SELECT * FROM esp_campaigns;
-- Same STEP 0 caveat as above.

CREATE OR REPLACE VIEW claude_domain_health AS
SELECT * FROM domain_health;

CREATE OR REPLACE VIEW claude_client_health AS
SELECT * FROM client_health_snapshots;

CREATE OR REPLACE VIEW claude_combo_history AS
SELECT * FROM combo_history;

-- mailbox_meta carries billing_start_date / billing_day / supplier.
-- Those are cost-side finance, so the view omits them.
CREATE OR REPLACE VIEW claude_mailboxes AS
SELECT email,
       workspace_id,
       status,
       provider
FROM mailbox_meta;
-- NOTE: billing_start_date, billing_day, supplier deliberately excluded.
-- Adjust the column list to match the real table (see STEP 0 output).

-- ---------------------------------------------------------------------
-- STEP 3. Grant read on the views only. No base tables are granted.
-- revenue_leads, monthly_expenses and revenue_manual_entries are never
-- granted, so /api/finance and /api/revenue data stays unreachable.
-- ---------------------------------------------------------------------
GRANT SELECT ON
  claude_leads,
  claude_workspace_stats,
  claude_campaigns,
  claude_domain_health,
  claude_client_health,
  claude_combo_history,
  claude_mailboxes
TO claude_ro;

-- ---------------------------------------------------------------------
-- STEP 4. Prove it worked. Run these as claude_ro.
-- The first should return rows. The rest should all fail with
-- "permission denied". If any of them succeed, stop and fix the grants.
-- ---------------------------------------------------------------------
--   SELECT count(*) FROM claude_leads;              -- expect: a number
--   SELECT * FROM revenue_leads LIMIT 1;            -- expect: permission denied
--   SELECT * FROM monthly_expenses LIMIT 1;         -- expect: permission denied
--   SELECT * FROM revenue_manual_entries LIMIT 1;   -- expect: permission denied
--   SELECT lead_price FROM claude_leads LIMIT 1;    -- expect: column does not exist
