import { Pool } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _portalPgPool: Pool | undefined
  var _portalMigrated: boolean | undefined
  var _portalMigratedPromise: Promise<void> | undefined
}

function createPool() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
  // A dropped idle connection (DB restart / network blip) emits 'error' on the
  // pool; without a listener Node kills the process. Log and let pg recover.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message))
  return pool
}

const pool = globalThis._portalPgPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalThis._portalPgPool = pool

// Run migration once per process start
async function runMigration() {
  try {
    const statements = [
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS hidden_fields TEXT[] DEFAULT '{}'`,
      // Contact/person name for a personal greeting ("Welcome back, Gareth").
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS contact_name TEXT`,
      // Username login (+ access code stored in password_hash). Email becomes optional.
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE portal_clients ALTER COLUMN email DROP NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_clients_username ON portal_clients (lower(username)) WHERE username IS NOT NULL`,
      `ALTER TABLE portal_clients ALTER COLUMN password_hash DROP NOT NULL`,
      // Self-service invite link: client opens it and sets their own username + code.
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS invite_token TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_clients_invite ON portal_clients (invite_token) WHERE invite_token IS NOT NULL`,
      // Multi-user / multi-workspace access. One login (identifier+code) can be
      // granted access to MANY client workspaces; a client workspace can have
      // MANY logins. Each row = "this login may view this client's workspace".
      // Login resolution checks here first, then falls back to portal_clients
      // (legacy single-login clients keep working unchanged).
      `CREATE TABLE IF NOT EXISTS portal_user_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identifier TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (identifier, client_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_portal_user_access_identifier ON portal_user_access (lower(identifier))`,
      // Admin can create a login before the client picks a code (self-service
      // invite), so the hash may be empty until claimed; invite_token is shared
      // across all of one identifier's rows so claiming it sets every workspace.
      `ALTER TABLE portal_user_access ALTER COLUMN password_hash DROP NOT NULL`,
      `ALTER TABLE portal_user_access ADD COLUMN IF NOT EXISTS invite_token TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_portal_user_access_invite ON portal_user_access (invite_token) WHERE invite_token IS NOT NULL`,
      // The person's name for this login — used for the welcome greeting + shown
      // in the admin Users list (so multiple users per client aren't just emails).
      `ALTER TABLE portal_user_access ADD COLUMN IF NOT EXISTS display_name TEXT`,
      // Per-user lead-notification opt-in. Default TRUE so new users get alerts
      // unless unticked. Admin toggles it in the Users modal.
      `ALTER TABLE portal_user_access ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE`,
      // Dedup for per-user lead emails (separate from the client-row dedup).
      `CREATE TABLE IF NOT EXISTS portal_user_lead_notifications (
        identifier TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (identifier, lead_id)
      )`,
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
      // One-off "start from scratch" marker. When set, lead auto-charging only
      // bills leads delivered AFTER this timestamp — pre-reset/backfilled leads
      // are never re-billed. Auto-charging stays ON for new leads going forward.
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS charges_reset_at TIMESTAMPTZ`,
      // Email-warmup window shown to the client as a progress bar ("how much
      // longer until leads start?"). Admin sets the start date + duration; when
      // start is null the bar is hidden. Default 14-day warmup.
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS warmup_start_date DATE`,
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS warmup_days INTEGER NOT NULL DEFAULT 14`,
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP'`,
      // Spend visibility to the client: 'auto' (reveal spend+ROI only when ROI>0),
      // 'hidden' (never show money/ROI — outcomes only), 'always' (full transparency).
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS spend_visibility TEXT NOT NULL DEFAULT 'auto'`,
      // Below this lead balance the header warns "Low on leads" (yellow). At 0 it's "Top Up Now" (red).
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS low_leads_threshold INTEGER NOT NULL DEFAULT 5`,
      // Per-client top-up buckets: [{ leads, pricePerLead }] — preset purchase
      // options with volume pricing (e.g. 10 @ £100 each, 30 @ £80 each).
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS topup_buckets JSONB NOT NULL DEFAULT '[]'`,
      // Per-client minimum custom top-up (leads).
      `ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS min_topup INTEGER NOT NULL DEFAULT 10`,

      // ── Client deal-stage label per lead (separate from internal/PV label) ──
      `ALTER TABLE portal_lead_data ADD COLUMN IF NOT EXISTS client_label TEXT`,
      // Stages flagged with prompts_value ask the client for a deal value the
      // moment a lead is moved into that stage (e.g. "Quote Sent", "Won").
      `ALTER TABLE portal_lead_data ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE portal_lead_data ADD COLUMN IF NOT EXISTS replied_off BOOLEAN NOT NULL DEFAULT FALSE`,
      // When the client first responded (portal reply or 'replied off-dashboard') —
      // used to measure Speed to Lead.
      `ALTER TABLE portal_lead_data ADD COLUMN IF NOT EXISTS first_responded_at TIMESTAMPTZ`,
      // Admin-uploaded invoice PDF (stored in-DB) + link a top-up request to its invoice.
      `ALTER TABLE portal_invoices ADD COLUMN IF NOT EXISTS file_data BYTEA`,
      `ALTER TABLE portal_invoices ADD COLUMN IF NOT EXISTS file_name TEXT`,
      `ALTER TABLE portal_invoices ADD COLUMN IF NOT EXISTS file_mime TEXT`,
      `ALTER TABLE portal_topup_requests ADD COLUMN IF NOT EXISTS invoice_id UUID`,
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

      // ── New-lead email dedup: exactly one notification per (client, lead) ──
      `CREATE TABLE IF NOT EXISTS portal_lead_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
        lead_id TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (client_id, lead_id)
      )`,
      // Retry state: failed sends keep their claim (no double-send on ambiguous
      // failures) and retry with backoff, capped — instead of delete-and-respin.
      `ALTER TABLE portal_lead_notifications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent'`,
      `ALTER TABLE portal_lead_notifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE portal_lead_notifications ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`,

      // Mark every lead that ALREADY exists as "notified" so enabling email
      // notifications doesn't blast clients with their whole back-catalogue —
      // only leads arriving after this point will trigger a send. Idempotent.
      `INSERT INTO portal_lead_notifications (client_id, lead_id)
         SELECT pc.id, l.id
           FROM portal_clients pc
           JOIN esp_leads l ON l.workspace_id = pc.workspace_id
            AND l.source IN ('plusvibe', 'bison') AND l.label = 'INTERESTED'
         ON CONFLICT (client_id, lead_id) DO NOTHING`,

      // ── Global settings (editable in admin) e.g. notification templates ──
      `CREATE TABLE IF NOT EXISTS portal_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // ── Master Unibox: aggregated Bison replies across all client workspaces ──
      // One row per Bison reply. classify_state drives the Claude triage worker;
      // folder drives the admin UI (review/inbox/done/unmapped/rejected). A reply
      // arriving is NOT billable — only the admin "Mark as lead" action sets
      // esp_leads.label='INTERESTED' (which reconcileLeadCharges keys on).
      `CREATE TABLE IF NOT EXISTS unibox_replies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bison_team_id TEXT NOT NULL,
        bison_reply_id TEXT NOT NULL,
        workspace_id TEXT,                         -- PV workspace_id (null if unmapped)
        portal_email_id TEXT,                      -- portal_emails.id, when stored
        lead_email TEXT NOT NULL,
        lead_bison_id TEXT,
        subject TEXT,
        body_preview TEXT,
        classify_state TEXT NOT NULL DEFAULT 'pending',   -- pending | done | failed
        classify_attempts INT NOT NULL DEFAULT 0,
        classify_next_at TIMESTAMPTZ,
        category TEXT,                             -- interested | not_interested | ooo_auto_reply | question | unsubscribe | other
        confidence NUMERIC(3,2),
        ai_model TEXT,
        ai_reasoning TEXT,
        admin_label TEXT,                          -- admin override of category
        admin_label_by TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox',      -- inbox | review | done | unmapped | rejected
        marked_as_lead BOOLEAN NOT NULL DEFAULT FALSE,
        marked_by TEXT,
        marked_at TIMESTAMPTZ,
        bison_tag_state TEXT,                      -- null | pending | done | failed
        raw JSONB DEFAULT '{}',
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bison_team_id, bison_reply_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_unibox_folder_state ON unibox_replies (folder, classify_state, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_unibox_pending ON unibox_replies (classify_state, classify_next_at) WHERE classify_state = 'pending'`,
      `CREATE INDEX IF NOT EXISTS idx_unibox_ws_email ON unibox_replies (workspace_id, lower(lead_email))`,
      // #2 forwarded/unlinked replies: when a reply isn't tied to a known lead,
      // we match it by email domain to an existing lead and flag it forwarded,
      // keeping BOTH the actual sender and the matched original lead.
      `ALTER TABLE unibox_replies ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE unibox_replies ADD COLUMN IF NOT EXISTS sender_email TEXT`,
      `ALTER TABLE unibox_replies ADD COLUMN IF NOT EXISTS matched_lead_email TEXT`,
      `ALTER TABLE unibox_replies ADD COLUMN IF NOT EXISTS matched_by TEXT`,

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
    // Clear the cached promise so the next ready() call retries the migration.
    globalThis._portalMigratedPromise = undefined
    throw err
  }
}

// Awaitable migration guard — webhook/cron/notify paths await this so they never
// race table creation or the notified-leads seed on a cold start.
export function ready(): Promise<void> {
  globalThis._portalMigratedPromise ??= runMigration()
  return globalThis._portalMigratedPromise.catch(() => {})
}

// Kick off migration immediately; auto-register Bison webhook once DB is ready.
ready().then(() => {
  import('./bison').then(({ registerWebhookAllWorkspaces }) => {
    // Register in EVERY workspace (Bison webhooks are per-workspace).
    registerWebhookAllWorkspaces().then(r => {
      console.log('[bison] webhooks registered:', JSON.stringify(r.results))
    }).catch(() => {})
  }).catch(() => {})
})

export default pool
