-- DUAL-ESP MIGRATION — NOT YET APPLIED. Requires Jesse's review & approval
-- before running (CLAUDE.md: never modify DB schema without asking).
-- All statements are additive + IF NOT EXISTS = safe to run repeatedly, and
-- preserve current behaviour (any workspace without a row defaults to PlusVibe).
--
-- NOTE ON DESIGN: the `clients` table lives in SQLite (better-sqlite3, ottaly.db),
-- but esp-sync/sync.js is a standalone process that only speaks Postgres, and the
-- push routes read Postgres via app.locals.pgDb. So the per-workspace ESP routing
-- config lives in a dedicated POSTGRES table (esp_routing) rather than as columns
-- on the SQLite clients table — same feature Jesse approved, sited where both the
-- sync process and the API can read it. Keyed by PlusVibe workspace_id (the app's
-- canonical client id, retained even after a client moves to Bison).

-- 1. Per-workspace ESP routing (Postgres — readable by sync.js and the API).
--    esp_provider:
--      'plusvibe' (default) → sync/push PlusVibe only (current behaviour)
--      'bison'              → Bison only (clean cutover; PV history kept, frozen)
--      'both'               → sync BOTH; stats union with Bison-wins per-mailbox
--                             dedup (a mailbox present on Bison is counted from
--                             Bison, not PV; PV-only mailboxes counted from PV).
--                             Use during a transition when a client sends on both.
CREATE TABLE IF NOT EXISTS esp_routing (
  pv_workspace_id TEXT PRIMARY KEY,                 -- canonical client id (PlusVibe workspace_id)
  esp_provider    TEXT NOT NULL DEFAULT 'plusvibe', -- 'plusvibe' | 'bison' | 'both'
  bison_team_id   TEXT,                             -- Bison team_id (required when esp_provider IN ('bison','both'))
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Mailbox dedup flag — Bison wins. A PlusVibe esp_email_accounts row whose
--    email also exists under source='bison' gets flagged so stats/health count
--    it once. The row is NEVER deleted and historical email_events are untouched.
ALTER TABLE esp_email_accounts ADD COLUMN IF NOT EXISTS superseded_by_bison BOOLEAN NOT NULL DEFAULT FALSE;

-- =========================================================================
-- SEED the known Bison mappings (from memory/project_bison_workspace_ids.md).
-- Inserting a row here flips that client to Bison. The 7 PV clients with no
-- Bison workspace are intentionally absent → they stay on PlusVibe.
-- Comment out any client you do NOT want migrated yet.
-- Re-runnable: ON CONFLICT updates the mapping.
-- =========================================================================
INSERT INTO esp_routing (pv_workspace_id, esp_provider, bison_team_id) VALUES
  ('690ee665bcb253de4fb44538', 'bison', '3'),   -- Ottaly
  ('6912ddfef9582848982b9a62', 'bison', '4'),   -- AccrueAccounting
  ('69a9db307af7ef2854f57637', 'bison', '5'),   -- ButterflyEco
  ('6a0cc49a4a80688441614dfb', 'bison', '12'),  -- MagnaMoney
  ('69ffaf6904ca7138af16013a', 'bison', '13'),  -- Bruud
  ('69c43d1e07bf312ff0026643', 'bison', '14'),  -- GXI-Furniture
  ('69c43d1407bf312ff0026642', 'bison', '15'),  -- GXI
  ('695259c3d6154e27d164bcf7', 'bison', '17'),  -- Indigo
  ('699714b02f0830a7148fcf3e', 'bison', '18'),  -- Enviro
  ('695259dc8de377db7577dc45', 'bison', '19'),  -- PPC
  ('697e20f02db8460f8ba68792', 'bison', '20'),  -- Jumping Spider (JSM)
  ('69525a0eceae00718efdaeaa', 'bison', '21'),  -- HydrationCompany
  ('69a686632f5aaca7d9602c1f', 'bison', '22'),  -- Animo
  ('6a1d40b3bb80380c1be750c6', 'bison', '23')   -- ButterflyEco SOP
ON CONFLICT (pv_workspace_id) DO UPDATE
  SET esp_provider = EXCLUDED.esp_provider,
      bison_team_id = EXCLUDED.bison_team_id,
      updated_at = now();
