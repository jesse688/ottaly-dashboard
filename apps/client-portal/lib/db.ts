import { Pool } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _portalPgPool: Pool | undefined
  var _portalMigrated: boolean | undefined
}

function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
}

const pool = globalThis._portalPgPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalThis._portalPgPool = pool

// Run migration once per process start
async function runMigration() {
  if (globalThis._portalMigrated) return
  globalThis._portalMigrated = true
  try {
    const statements = [
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS hidden_fields TEXT[] DEFAULT '{}'`,
      // Username login (+ access code stored in password_hash). Email becomes optional.
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE portal_clients ALTER COLUMN email DROP NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_clients_username ON portal_clients (lower(username)) WHERE username IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS portal_client_labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'purple',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS portal_lead_disputes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id TEXT NOT NULL,
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        admin_note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        UNIQUE(lead_id, client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS portal_lead_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id TEXT NOT NULL,
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        deal_value NUMERIC(12,2),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(lead_id, client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS portal_invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        invoice_number TEXT,
        description TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        status TEXT NOT NULL DEFAULT 'unpaid',
        due_date DATE,
        paid_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // ── Per-client pricing + currency ──────────────────────────────
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS cost_per_lead NUMERIC(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP'`,
      // Spend visibility to the client: 'auto' (reveal spend+ROI only when ROI>0),
      // 'hidden' (never show money/ROI — outcomes only), 'always' (full transparency).
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS spend_visibility TEXT NOT NULL DEFAULT 'auto'`,

      // ── Client deal-stage label per lead (separate from internal/PV label) ──
      `ALTER TABLE portal_lead_data ADD COLUMN IF NOT EXISTS client_label TEXT`,
      // Stages flagged with prompts_value ask the client for a deal value the
      // moment a lead is moved into that stage (e.g. "Quote Sent", "Won").
      `ALTER TABLE portal_client_labels ADD COLUMN IF NOT EXISTS prompts_value BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE portal_client_labels ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
      // Non-lead reports: type = 'non_lead' (tried, no response — effort-gated) or
      // 'icp_mismatch' (wrong fit, not worth replying — no gate). category = sub-reason.
      `ALTER TABLE portal_lead_disputes ADD COLUMN IF NOT EXISTS category TEXT`,
      `ALTER TABLE portal_lead_disputes ADD COLUMN IF NOT EXISTS dispute_type TEXT NOT NULL DEFAULT 'non_lead'`,

      // ── Real email conversations cached from PlusVibe /unibox/emails ──
      `CREATE TABLE IF NOT EXISTS portal_emails (
        id TEXT PRIMARY KEY,                       -- PlusVibe message id
        workspace_id TEXT NOT NULL,
        lead_pv_id TEXT,                           -- PlusVibe lead _id
        lead_email TEXT NOT NULL,                  -- join key to esp_leads.email
        thread_id TEXT,
        campaign_id TEXT,
        direction TEXT NOT NULL,                   -- IN | OUT
        subject TEXT,
        body_html TEXT,
        body_text TEXT,
        content_preview TEXT,
        from_email TEXT,
        to_email TEXT,
        eaccount TEXT,                             -- sending mailbox
        pv_label TEXT,                             -- OUT_OF_OFFICE / AUTOMATIC_REPLY / etc.
        is_unread INTEGER DEFAULT 0,
        message_id TEXT,                           -- RFC Message-ID (for live reply threading)
        sent_via_portal BOOLEAN DEFAULT FALSE,     -- true if composed in our portal
        timestamp_created TIMESTAMPTZ,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_portal_emails_ws_lead ON portal_emails (workspace_id, lower(lead_email))`,
      `CREATE INDEX IF NOT EXISTS idx_portal_emails_thread ON portal_emails (thread_id)`,

      // ── Lead-credit balance ledger ─────────────────────────────────
      // type: topup (+), lead_charge (-), dispute_refund (+), adjustment (+/-)
      // amount is signed: positive = credit, negative = debit
      `CREATE TABLE IF NOT EXISTS portal_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        lead_id TEXT,                              -- esp_leads.id for lead_charge / refund
        description TEXT,
        created_by TEXT,                           -- 'system' | 'admin' | 'webhook'
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      // One charge per (client, lead) and one refund per (client, lead) — idempotency guards
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_lead_charge ON portal_ledger (client_id, lead_id) WHERE type = 'lead_charge'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_lead_refund ON portal_ledger (client_id, lead_id) WHERE type = 'dispute_refund'`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_client ON portal_ledger (client_id, created_at DESC)`,

      // ── Client top-up requests (manual confirm flow) ───────────────
      `CREATE TABLE IF NOT EXISTS portal_topup_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',    -- pending | confirmed | cancelled
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        confirmed_at TIMESTAMPTZ
      )`,

      // ── Admin notifications inbox (top-up requests, invoice-paid pings, replies) ──
      `CREATE TABLE IF NOT EXISTS portal_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES portal_clients(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                        -- topup_request | invoice_paid | reply_sent | dispute
        title TEXT NOT NULL,
        body TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // ── One-time migrations marker table ───────────────────────────
      `CREATE TABLE IF NOT EXISTS portal_meta (key TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW())`,
      // The ledger switched from money units to LEAD-COUNT units. Wipe any
      // pre-existing money-denominated rows once so the balance rebuilds cleanly
      // (lead_charges re-reconcile as -1 each; top-ups are re-added in leads).
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM portal_meta WHERE key = 'ledger_lead_units_v1') THEN
           DELETE FROM portal_ledger;
           INSERT INTO portal_meta(key) VALUES ('ledger_lead_units_v1');
         END IF;
       END $$;`,
    ]
    for (const sql of statements) {
      await pool.query(sql)
    }
    console.log('[db] migration complete')
  } catch (err) {
    console.error('[db] migration error:', err)
    globalThis._portalMigrated = false
  }
}

// Kick off migration immediately (non-blocking)
runMigration()

export default pool
