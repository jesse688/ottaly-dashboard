const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const dnsPromises = require('dns').promises;

// Single definition of the company_domain normalisation, shared with the ads
// checker's stamping queries. The index below and those queries MUST use the
// identical expression or Postgres silently ignores the index — importing it
// rather than re-typing it makes drift impossible.
const { DOMAIN_NORM_SQL } = require('./lib/adscheck/schema');

// Dedicated resolver for high-volume MX enrichment. Routing these lookups through
// public resolvers (Cloudflare / Google) instead of the server's default resolver
// means our ~8k-per-run MX queries blend into global query volume rather than
// leaving an automated DNS signature attributable to our IP.
const { Resolver } = require('dns').promises;
const mxResolver = new Resolver();
mxResolver.setServers(['1.1.1.1', '8.8.8.8']);

class PostgresDatabase {
  constructor() {
    this.pool = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    // Support any PostgreSQL connection string via DATABASE_URL
    const dbUrl = process.env.DATABASE_URL || '';
    const sslDisabled = dbUrl.includes('sslmode=disable') || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
    // Pool sized for high concurrency — parallel index builds, webhook
    // bursts, dashboard fan-out (search + count + employee buckets +
    // email-provider counts), and CSV imports all share the pool.
    // Lowered 60→40→25: during a rolling deploy BOTH old and new replicas are alive
    // briefly. Enrichment job also holds connections. 2 replicas × 25 = 50 leaves
    // comfortable headroom under Postgres max_connections (200 limit).
    const config = dbUrl ? {
      connectionString: dbUrl,
      ssl: sslDisabled ? false : { rejectUnauthorized: false },
      max: 25,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Kill runaway queries fast. 120s was pegging CPU because expensive
      // ILIKE-OR searches that previously timed out at 30s now ran to
      // completion. 45s catches genuinely-stuck queries while keeping the
      // CPU ceiling sane. Bump only after query plans are confirmed cheap.
      statement_timeout: 45000,
    } : {
      user: process.env.DB_USER || 'ottaly',
      password: process.env.DB_PASSWORD || 'ottaly_dev',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'ottaly_contacts',
      max: 60,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 45000,
    };

    this.pool = new Pool(config);

    this.pool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', err);
    });

    try {
      const client = await this.pool.connect();
      console.log('[PostgreSQL] Connected to database');
      client.release();
      this.initialized = true;

      // Schema setup runs in BACKGROUND — previous instances may still be
      // holding locks on contacts during a rolling deploy, and ALTER TABLE
      // statements would block waiting for them. Letting init() return
      // immediately means app.listen() fires within ~1s of DB connect.
      // The schema migrations are idempotent (IF NOT EXISTS everywhere)
      // so any in-flight queries against missing columns are impossible
      // — those columns exist from a prior deploy. The only thing we'd
      // be racing against is adding a brand-new column, which won't be
      // referenced until this deploy's code runs queries that need it.
      this.setupSchema().catch(err => {
        console.error('[PostgreSQL] Background schema setup failed:', err.message);
      });
    } catch (err) {
      console.error('[PostgreSQL] Connection failed:', err.message);
      throw err;
    }
  }

  async setupSchema() {
    const schemaPath = path.resolve(__dirname, 'db-schema-postgres.sql');
    if (!fs.existsSync(schemaPath)) {
      console.warn('[PostgreSQL] Schema file not found, skipping setup');
      return;
    }

    // Use a dedicated client with a 5s lock_timeout so migrations don't
    // hang waiting on the previous deploy's still-running queries. If a
    // lock is contested, we skip that statement and retry later — better
    // than blocking the entire startup.
    const client = await this.pool.connect();
    try {
      await client.query(`SET lock_timeout = '5s'`);
      await client.query(`SET statement_timeout = '60s'`);

      const schema = fs.readFileSync(schemaPath, 'utf8');
      const statements = schema
        .split(/;\s*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));
      let schemaErrors = 0;
      for (const stmt of statements) {
        try { await client.query(stmt); }
        catch (err) {
          if (!/already exists|lock timeout/i.test(err.message)) {
            console.error('[PostgreSQL] Schema error:', err.message.slice(0, 120));
            schemaErrors++;
          }
        }
      }
      if (schemaErrors === 0) console.log('[PostgreSQL] Schema ready');
      client.release();
    } catch (err) {
      client.release();
      throw err;
    }

    // Add missing columns to existing tables (safe migrations)
    const migrations = [
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_address TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_city TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_state TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_country TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS industry TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS num_employees INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS keywords TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS technologies TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS corporate_phone TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_phone TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sub_departments TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_status TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mx_provider TEXT`,
      // Solar CCOD ownership sweep (Land Registry). Kept SEPARATE from the
      // reply-derived owns_building signal above so the two never collide.
      // ccod_owns_building: yes|no|unclear|no_postcode. ccod_site_count: the
      // lead company's own multi-site count.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ccod_owns_building TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ccod_building_owner TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ccod_site_count INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ccod_checked_at TIMESTAMP`,
      // Solar qualification RESULTS — persisted so a re-run reuses them instead of
      // re-spending Google geocode + buildingInsights calls (and re-blocking the
      // server on the offline CCOD scans). solar_checked_at != NULL = already done.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_checked_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_status TEXT`,        -- qualified | disqualified
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_stop_reason TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_max_kwp INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_panels INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_annual_kwh INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_roof_area_m2 INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_has_solar TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_lat DOUBLE PRECISION`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_lng DOUBLE PRECISION`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_roof_address TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_maps_url TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS solar_imagery_date TEXT`,
      // Google Ads Transparency RESULTS — stamped by the ads-checker worker
      // (lib/adscheck) so the Contacts grid can filter on "runs Google ads" and
      // a PlusVibe push can be built straight from it. ads_domain_cache stays
      // the reusable per-DOMAIN source of truth; these are its per-CONTACT
      // projection, stamped onto every contact sharing the checked domain.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ads_runs_ads BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ads_count INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ads_is_estimate BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ads_advertisers JSONB`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ads_checked_at TIMESTAMP`,
      // Intelligence columns from reply parsing
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS works_remote BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owns_building TEXT DEFAULT 'unknown'`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN DEFAULT false`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS snoozed_verticals JSONB DEFAULT '[]'`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reply_notes TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marked_as_lead_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bounce_type TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS soft_bounce_count INT DEFAULT 0`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_count INT DEFAULT 0`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS emailed_workspaces JSONB DEFAULT '{}'`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_campaign_name TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS exported_to_apollo_at TIMESTAMP`,
      // Per-campaign push history. Each entry: {workspace_id, campaign_id,
      // campaign_name, pushed_at}. Used by verify-and-push to skip contacts
      // already pushed to this exact campaign — last_campaign_name alone
      // only remembers the most-recent push so it leaked when campaigns
      // interleaved.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pushed_campaigns JSONB DEFAULT '[]'`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_status TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_company_number TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_company_type TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_founded_year INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_postcode TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_sic_codes TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_jurisdiction TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_has_insolvency BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_has_charges BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_accounts_overdue BOOLEAN`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_active_officers INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_resigned_officers INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_address TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_date_of_cessation TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_last_accounts_date TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_year_end_month INT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_data JSONB`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`,
      // CH registration-number re-verification job. ch_verified_at is the resume
      // gate (NULL = not yet processed this run). ch_match_confidence records how
      // the number was validated: 'confident' (name + full-postcode + active),
      // 'medium' (name + outcode-only + active), or 'none' (cleared — no confident
      // name match, dissolved/inactive, or postcode disagreed). See verifyContactCH.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_verified_at TIMESTAMP`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ch_match_confidence TEXT`,
      // ── Normalised location hierarchy ────────────────────────────
      // Clean Country > Region > County > City > Town, derived by the
      // location-normalizer (postcode-area primary, place-name fallback).
      // Company is the default target; person_* mirror it for the person.
      // location_source ∈ postcode|place|county|country|website|manual.
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_region TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_county TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_town TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS person_region TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS person_county TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS person_town TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_source TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_needs_review BOOLEAN DEFAULT false`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_review_reason TEXT`,
      `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_normalized_at TIMESTAMPTZ`,
      // template_alerts columns added after initial table creation
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS dismissed_by TEXT`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS dismissed_reason TEXT`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS target_metric TEXT`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS target_direction TEXT`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS baseline_value NUMERIC`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS followup_value NUMERIC`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS outcome TEXT`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMP`,
      `ALTER TABLE template_alerts ADD COLUMN IF NOT EXISTS outcome_notes TEXT`,
      // ── Domain health table ──────────────────────────────────────
      // Free per-domain reputation snapshot built from DNS + blacklist
      // checks (no Google Postmaster account needed). Refreshed nightly
      // by refreshDomainHealth() in server.js.
      `CREATE TABLE IF NOT EXISTS domain_health (
        domain         TEXT PRIMARY KEY,
        workspace_id   TEXT,
        workspace_name TEXT,
        spf            JSONB DEFAULT '{}',
        dkim           JSONB DEFAULT '{}',
        dmarc          JSONB DEFAULT '{}',
        mx             JSONB DEFAULT '{}',
        blacklists     JSONB DEFAULT '[]',
        score          INT DEFAULT 0,
        status         TEXT DEFAULT 'unknown',
        last_checked   TIMESTAMP,
        notes          TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_domain_health_workspace ON domain_health (workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_domain_health_status    ON domain_health (status)`,
      // Where the domain root redirects to (final URL + status chain). Reported,
      // not scored — surfaced on the Domains page so broken/missing redirects
      // are visible. { ok, final_url, status, chain[], error }
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS redirect JSONB DEFAULT '{}'`,
      // The redirect target this domain SHOULD land on. Set per-domain in the UI.
      // The Domains page compares the actual redirect final_url against this and
      // shows green (match) / red (mismatch or unset-but-broken).
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS expected_redirect TEXT`,
      // Tombstone flag — when set, the auto-refresh skips re-adding this
      // domain even though PlusVibe still lists it. Used for inactive
      // clients or sunset domains. ignored_at is a soft-delete: the row
      // stays so a user can un-ignore later without losing history.
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS ignored_at TIMESTAMP`,
      // Postmaster Tools registration tracking (Google Site Verification flow).
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS pm_txt_token    TEXT`,
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS pm_txt_added_at TIMESTAMP`,
      `ALTER TABLE domain_health ADD COLUMN IF NOT EXISTS pm_verified_at  TIMESTAMP`,
      // ── Combo analysis historical cache ──────────────────────────
      // Approximate FROM×TO provider stats built from PlusVibe workspace
      // totals + mailbox_meta type distribution + contacts mx_provider.
      `CREATE TABLE IF NOT EXISTS combo_history (
        workspace_id  TEXT    NOT NULL,
        date          TEXT    NOT NULL,
        from_type     TEXT    NOT NULL,
        to_type       TEXT    NOT NULL,
        sent          INT     NOT NULL DEFAULT 0,
        replies       INT     NOT NULL DEFAULT 0,
        pos_replies   INT     NOT NULL DEFAULT 0,
        bounces       INT     NOT NULL DEFAULT 0,
        leads         INT     NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, date, from_type, to_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_combo_history_date ON combo_history (date)`,
      // ── Manager payslips ─────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS payslips (
        id           BIGSERIAL PRIMARY KEY,
        manager_name TEXT NOT NULL,
        month        TEXT NOT NULL,
        filename     TEXT NOT NULL,
        mimetype     TEXT NOT NULL DEFAULT 'application/pdf',
        data         TEXT NOT NULL,
        uploaded_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (manager_name, month)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_payslips_manager ON payslips (manager_name)`,
      // ── App-wide settings (key/value store) ──────────────────────
      `CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      // ── Central per-workspace stats cache ────────────────────────
      // Single source of truth for aggregate metrics (lead counts, send
      // counts, reply rates, mailbox counts, capacity gaps, etc.) so every
      // page reads from the same numbers. Refreshed periodically by
      // refreshAllWorkspaceStats() in server.js.
      `CREATE TABLE IF NOT EXISTS workspace_stats (
        workspace_id   TEXT PRIMARY KEY,
        workspace_name TEXT,
        stats          JSONB NOT NULL DEFAULT '{}',
        computed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      // ── Google Postmaster Tools daily snapshots ──────────────────
      // One row per (domain, date). The API only returns data for
      // domains registered in Postmaster Tools. ip_reputation is the
      // worst bucket seen (BAD > LOW > MEDIUM > HIGH) for that day.
      `CREATE TABLE IF NOT EXISTS postmaster_data (
        domain            TEXT NOT NULL,
        date              TEXT NOT NULL,
        domain_reputation TEXT,
        ip_reputation     TEXT,
        spam_rate         NUMERIC,
        spf_pass_rate     NUMERIC,
        dkim_pass_rate    NUMERIC,
        dmarc_pass_rate   NUMERIC,
        ip_reputations    JSONB DEFAULT '[]',
        raw_data          JSONB,
        fetched_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (domain, date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_postmaster_domain ON postmaster_data (domain)`,
      `CREATE INDEX IF NOT EXISTS idx_postmaster_date   ON postmaster_data (date DESC)`,
      // ── Mailbox metadata ─────────────────────────────────────────
      // User-assigned tagging on top of PlusVibe data. PlusVibe knows
      // the technical provider (GOOGLE / MICROSOFT365 / SMTP) but not
      // *who supplied the mailbox* (Maildoso, Mithun, Winnr, …). We
      // store that here so the Mailboxes dashboard can group + compare
      // performance per supplier and per type.
      `CREATE TABLE IF NOT EXISTS mailbox_meta (
        email             TEXT PRIMARY KEY,
        supplier          TEXT,
        mailbox_type      TEXT,
        notes             TEXT,
        ignored_at        TIMESTAMP,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mailbox_meta_supplier ON mailbox_meta (supplier)`,
      `CREATE INDEX IF NOT EXISTS idx_mailbox_meta_type     ON mailbox_meta (mailbox_type)`,
      // Billing tracking — when the mailbox was purchased and which day of
      // the month it renews. billing_start_date is YYYY-MM-DD; billing_day
      // is 1-31 (the day of month the supplier invoices). Lets us show
      // "next renewal: 18 Jun" and flag mailboxes with upcoming renewals.
      `ALTER TABLE mailbox_meta ADD COLUMN IF NOT EXISTS billing_start_date DATE`,
      `ALTER TABLE mailbox_meta ADD COLUMN IF NOT EXISTS billing_day INT`,
      // ── Mailbox pricing (supplier × type → unit cost / month) ─────
      `CREATE TABLE IF NOT EXISTS mailbox_pricing (
        supplier      TEXT NOT NULL,
        mailbox_type  TEXT NOT NULL,
        unit_cost     NUMERIC(10,2) NOT NULL DEFAULT 0,
        currency      TEXT NOT NULL DEFAULT 'USD',
        notes         TEXT,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (supplier, mailbox_type)
      )`,
      // ── Monthly operating expenses (recurring or one-off) ──────────
      // start_month and end_month are inclusive YYYY-MM strings; end_month
      // NULL means "ongoing". Lets us turn an expense off without deleting
      // history so prior-month P&Ls stay consistent.
      `CREATE TABLE IF NOT EXISTS perf_cache_daily (
        ws_id      TEXT NOT NULL,
        date       TEXT NOT NULL,
        data       JSONB NOT NULL,
        saved_at   BIGINT NOT NULL,
        PRIMARY KEY (ws_id, date)
      )`,
      `CREATE TABLE IF NOT EXISTS perf_cache_leads (
        ws_id      TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        saved_at   BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS provider_mix_cache (
        ws_id      TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        saved_at   BIGINT NOT NULL
      )`,
      // The first cut of this table was per-mailbox (PK mailbox_email,date).
      // It never held real data (the sync recorded 0 rows), so drop it and
      // recreate at the cheaper provider/supplier grain. Safe: no data lost.
      `DROP TABLE IF EXISTS mailbox_daily_stats`,
      // ── Provider/supplier daily stats (the start of the central data layer) ──
      // One row per (workspace, provider, supplier, day): sent/bounced pulled
      // from Bison's breakdownOfEventsByDate (GET /api/campaign-events/stats),
      // filtered by ALL of that bucket's sender_email_ids in ONE call (the API
      // aggregates over the ids passed). ~80 calls/sync instead of one-per-
      // mailbox. Lets the Mailboxes page filter by any date range instantly.
      // Replies are NOT trusted from here — the page overlays portal replies
      // (unibox_replies) on top — but we store the Bison count as a fallback.
      `CREATE TABLE IF NOT EXISTS mailbox_daily_stats (
        workspace_id  TEXT NOT NULL DEFAULT '',
        provider      TEXT NOT NULL DEFAULT 'smtp',
        supplier      TEXT NOT NULL DEFAULT '',
        date          DATE NOT NULL,
        sent          INT  NOT NULL DEFAULT 0,
        replied       INT  NOT NULL DEFAULT 0,
        bounced       INT  NOT NULL DEFAULT 0,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, provider, supplier, date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mbds_date     ON mailbox_daily_stats (date)`,
      `CREATE INDEX IF NOT EXISTS idx_mbds_provider ON mailbox_daily_stats (provider)`,
      `CREATE INDEX IF NOT EXISTS idx_mbds_supplier ON mailbox_daily_stats (supplier)`,
      `CREATE TABLE IF NOT EXISTS monthly_expenses (
        id            SERIAL PRIMARY KEY,
        label         TEXT NOT NULL,
        category      TEXT,
        amount        NUMERIC(10,2) NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'USD',
        start_month   TEXT NOT NULL,
        end_month     TEXT,
        notes         TEXT,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_monthly_expenses_start ON monthly_expenses (start_month)`,
      // Per-campaign filter snapshots — when a user pushes to a campaign,
      // they can opt to save the current DataBase 1.0 filter set against
      // that campaign. Next time they search for more leads, they can
      // recall the saved filter from a Client→Campaign cascading dropdown.
      `CREATE TABLE IF NOT EXISTS campaign_filters (
        workspace_id    TEXT NOT NULL,
        workspace_name  TEXT,
        campaign_id     TEXT NOT NULL,
        campaign_name   TEXT,
        filters         JSONB NOT NULL,
        saved_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_campaign_filters_workspace ON campaign_filters (workspace_id)`,
      // Cooldown check filters on (workspace_id, last_emailed_at); partial
      // index keeps it small and only useful rows (NULL means 'never sent
      // by us', which the filter lets through anyway).
      `CREATE INDEX IF NOT EXISTS idx_contacts_last_emailed_at ON contacts (workspace_id, last_emailed_at) WHERE last_emailed_at IS NOT NULL`,

      // ── Client Health analytics ────────────────────────────────────
      // Denormalized event log written from the PlusVibe webhook so we can
      // slice reply/bounce/lead activity by template, campaign-step, and
      // recipient provider — none of which the per-workspace daily stats
      // expose.
      `CREATE TABLE IF NOT EXISTS email_events (
        id              BIGSERIAL PRIMARY KEY,
        workspace_id    TEXT,
        campaign_id     TEXT,
        campaign_name   TEXT,
        step            INT,
        variant         TEXT,
        lead_email      TEXT,
        recipient_domain TEXT,
        provider_bucket TEXT,
        event_type      TEXT,
        event_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        content_hash    TEXT,
        raw             JSONB
      )`,
      `ALTER TABLE email_events ADD COLUMN IF NOT EXISTS sender_email TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_ee_sender       ON email_events (sender_email) WHERE sender_email IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_ee_ws_event_at  ON email_events (workspace_id, event_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ee_campaign     ON email_events (workspace_id, campaign_id, event_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ee_template     ON email_events (content_hash, event_at DESC) WHERE content_hash IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_ee_event_type   ON email_events (event_type, event_at DESC)`,
      // Combo analysis send-anchored attribution looks up follow-up events by
      // (workspace_id, lower(lead_email)) — without this index every recipient
      // EXISTS would scan the workspace, blowing the 45s statement timeout.
      `CREATE INDEX IF NOT EXISTS idx_ee_ws_lead      ON email_events (workspace_id, lower(lead_email), event_type)`,

      // Templates — content-hashed subject+body, deduped across campaigns
      // and clients. Lets us see "this exact subject has shipped N times
      // across X clients" — the only honest signal of provider profiling.
      `CREATE TABLE IF NOT EXISTS templates (
        content_hash  TEXT PRIMARY KEY,
        subject_hash  TEXT,
        subject       TEXT,
        body          TEXT,
        body_excerpt  TEXT,
        first_seen    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_templates_subject_hash ON templates (subject_hash)`,

      // Maps each (workspace, campaign, step, variant) to its current
      // template content. Populated by the daily campaign-content sync.
      `CREATE TABLE IF NOT EXISTS campaign_templates (
        workspace_id    TEXT NOT NULL,
        campaign_id     TEXT NOT NULL,
        campaign_name   TEXT,
        step            INT  NOT NULL,
        variant         TEXT NOT NULL DEFAULT 'A',
        content_hash    TEXT,
        active          BOOLEAN DEFAULT TRUE,
        campaign_status TEXT,
        captured_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant)
      )`,
      `ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS campaign_status TEXT`,
      // captured_at = FIRST time we saw this row (drives "Running since"); the
      // upsert keeps it insert-only so it's never reset on re-sync. We do NOT
      // add a last_captured_at column: ADD COLUMN needs an AccessExclusive lock
      // that times out (lock_timeout 5s) against the constant writes to this
      // table, so it silently never applies and breaks every query/upsert that
      // references it. Recency ordering uses MAX(captured_at) instead.
      `CREATE INDEX IF NOT EXISTS idx_ct_workspace ON campaign_templates (workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ct_content   ON campaign_templates (content_hash)`,

      // Per-variant stats from PlusVibe's /campaign/get/variation-stats. The
      // sent/reply webhook payloads don't include step, so step-level
      // attribution is impossible from webhook data alone. This table holds
      // PlusVibe's own per-step counts as the source of truth.
      `CREATE TABLE IF NOT EXISTS campaign_variant_stats (
        workspace_id  TEXT NOT NULL,
        campaign_id   TEXT NOT NULL,
        step          INT  NOT NULL,
        variant       TEXT NOT NULL DEFAULT 'A',
        sent          INT  DEFAULT 0,
        reply         INT  DEFAULT 0,
        bounce        INT  DEFAULT 0,
        opened        INT  DEFAULT 0,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cvs_workspace ON campaign_variant_stats (workspace_id)`,

      // Daily snapshots of campaign_variant_stats. Lets us compute true
      // last-7-day deltas (current - 7-day-old snapshot) so the UI can
      // surface decay vs lifetime — the strongest signal for ESP profiling.
      // One row per (workspace, campaign, step, variant, day).
      `CREATE TABLE IF NOT EXISTS campaign_variant_stats_snapshots (
        workspace_id  TEXT NOT NULL,
        campaign_id   TEXT NOT NULL,
        step          INT  NOT NULL,
        variant       TEXT NOT NULL DEFAULT 'A',
        snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
        sent          INT  DEFAULT 0,
        reply         INT  DEFAULT 0,
        bounce        INT  DEFAULT 0,
        opened        INT  DEFAULT 0,
        snapshot_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant, snapshot_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cvss_ws_date ON campaign_variant_stats_snapshots (workspace_id, snapshot_date DESC)`,

      // Per-template decay / over-use / provider-split alerts. The Client
      // Health page surfaces open rows (dismissed_at IS NULL).
      `CREATE TABLE IF NOT EXISTS template_alerts (
        id                   BIGSERIAL PRIMARY KEY,
        workspace_id         TEXT,
        campaign_id          TEXT,
        campaign_name        TEXT,
        step                 INT,
        variant              TEXT,
        content_hash         TEXT,
        alert_type           TEXT,
        severity             TEXT,
        reply_rate_baseline  NUMERIC,
        reply_rate_current   NUMERIC,
        lifetime_sends       INT,
        details              JSONB,
        created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        dismissed_at         TIMESTAMP,
        resolved_at          TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ta_open ON template_alerts (workspace_id, created_at DESC) WHERE dismissed_at IS NULL AND resolved_at IS NULL`,

      // Daily per-client health snapshot — written by the nightly cron.
      // Score is mechanical (built from the numeric signals here); the AI
      // briefing interprets *why* the score moved.
      `CREATE TABLE IF NOT EXISTS client_health_snapshots (
        workspace_id            TEXT NOT NULL,
        snapshot_date           DATE NOT NULL,
        health_score            INT,
        health_band             TEXT,
        sent_7d                 INT,
        sent_30d                INT,
        replies_7d              INT,
        replies_30d             INT,
        bounces_7d              INT,
        bounces_30d             INT,
        leads_7d                INT,
        leads_30d               INT,
        reply_rate_7d           NUMERIC,
        reply_rate_30d          NUMERIC,
        reply_rate_baseline     NUMERIC,
        bounce_rate_7d          NUMERIC,
        reply_rate_gmail_7d     NUMERIC,
        reply_rate_outlook_7d   NUMERIC,
        mailbox_total           INT,
        mailbox_unhealthy       INT,
        domain_unhealthy        INT,
        copy_alerts_open        INT,
        ai_briefing             TEXT,
        ai_actions              JSONB,
        signals                 JSONB,
        PRIMARY KEY (workspace_id, snapshot_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chs_date ON client_health_snapshots (snapshot_date DESC, workspace_id)`,

      // Lead-target tracking on the health snapshot. Added after initial
      // ship so this runs as an ALTER on existing rows (NULLs are fine —
      // means "no target was set when this snapshot was built").
      `ALTER TABLE client_health_snapshots ADD COLUMN IF NOT EXISTS lead_target_monthly INT`,
      `ALTER TABLE client_health_snapshots ADD COLUMN IF NOT EXISTS leads_mtd           INT`,
      `ALTER TABLE client_health_snapshots ADD COLUMN IF NOT EXISTS leads_expected_mtd  NUMERIC`,
      `ALTER TABLE client_health_snapshots ADD COLUMN IF NOT EXISTS pace_pct            NUMERIC`,
      // Tracks whether the briefing came from Claude or the deterministic
      // fallback — so the UI can show the truth instead of inferring from
      // a runtime "is key set" check (which lies after a key is added but
      // before snapshots are rebuilt, or when Claude returns a 401/error).
      `ALTER TABLE client_health_snapshots ADD COLUMN IF NOT EXISTS ai_briefing_source TEXT`,

      // ── Actionable briefings — every AI action becomes a tracked row ──
      // The AI is forced (via prompt) to return concrete, checkable actions
      // instead of "monitor this client". Each action gets a row here so
      // the campaign manager can tick it off, and so the outcome evaluator
      // (next phase) can check 24h later whether the target metric moved.
      `CREATE TABLE IF NOT EXISTS health_actions (
        id                BIGSERIAL PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        snapshot_date     DATE NOT NULL,
        -- The action itself
        label             TEXT NOT NULL,
        kind              TEXT NOT NULL,
        payload           JSONB DEFAULT '{}'::jsonb,
        rationale         TEXT,
        priority          INT DEFAULT 2,
        -- Lifecycle
        proposed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at      TIMESTAMP,
        completed_by      TEXT,
        dismissed_at      TIMESTAMP,
        dismissed_by      TEXT,
        dismissed_reason  TEXT,
        -- Outcome tracking (filled by the daily evaluator cron — phase 2)
        target_metric     TEXT,
        target_direction  TEXT,
        baseline_value    NUMERIC,
        followup_value    NUMERIC,
        outcome           TEXT,
        outcome_at        TIMESTAMP,
        outcome_notes     TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ha_open
         ON health_actions (workspace_id, snapshot_date DESC, priority)
         WHERE completed_at IS NULL AND dismissed_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_ha_completed_pending_outcome
         ON health_actions (completed_at)
         WHERE completed_at IS NOT NULL AND outcome IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_ha_history
         ON health_actions (workspace_id, kind, outcome)
         WHERE outcome IS NOT NULL`,

      // ── Audience scoring — lookalike TAM scoring per client ───────────
      // Responder profile: top attribute values (seniority, industry, etc.)
      // computed from who replied/became a lead for each workspace.
      `CREATE TABLE IF NOT EXISTS client_audience_profiles (
        workspace_id   TEXT PRIMARY KEY,
        responder_count INT DEFAULT 0,
        sent_count      INT DEFAULT 0,
        profile         JSONB DEFAULT '{}'::jsonb,
        computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Per-contact score for each workspace: 0-100, breakdown of which
      // features matched the responder profile, recomputed on demand / nightly.
      `CREATE TABLE IF NOT EXISTS audience_scores (
        workspace_id  TEXT NOT NULL,
        contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        score         INT  NOT NULL DEFAULT 0,
        breakdown     JSONB DEFAULT '{}'::jsonb,
        computed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, contact_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_as_workspace_score
         ON audience_scores (workspace_id, score DESC)`,

      // ── Revenue leads — persistent store so leads survive PlusVibe workspace deletion ──
      `CREATE TABLE IF NOT EXISTS revenue_leads (
        lead_key        TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        workspace_name  TEXT NOT NULL DEFAULT '',
        client_name     TEXT NOT NULL DEFAULT '',
        lead_email      TEXT DEFAULT '',
        first_name      TEXT DEFAULT '',
        last_name       TEXT DEFAULT '',
        campaign        TEXT DEFAULT '',
        lead_price      NUMERIC(10,4) DEFAULT 0,
        date            TEXT DEFAULT '',
        label           TEXT DEFAULT '',
        pv_nonlead      BOOLEAN DEFAULT false,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_revenue_leads_workspace ON revenue_leads (workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_revenue_leads_date      ON revenue_leads (date)`,

      // ── Manual revenue entries — admin-entered revenue for deleted/historical clients ──
      `CREATE TABLE IF NOT EXISTS revenue_manual_entries (
        id             SERIAL PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        month          TEXT NOT NULL,
        lead_count     INT NOT NULL DEFAULT 1,
        price_per_lead NUMERIC(10,4) NOT NULL DEFAULT 0,
        note           TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rme_workspace ON revenue_manual_entries (workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_rme_month     ON revenue_manual_entries (month)`,

      // ── Diagnostic Intelligence System (Phase 1+) ──
      `CREATE TABLE IF NOT EXISTS diagnostic_signals (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT NOW(),
        signal_type TEXT NOT NULL,
        workspace_id TEXT,
        metric_key TEXT NOT NULL,
        metric_value FLOAT NOT NULL,
        unit TEXT,
        status TEXT,
        notes TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ds_type_ts ON diagnostic_signals (signal_type, timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ds_ws_ts  ON diagnostic_signals (workspace_id, timestamp DESC)`,

      `CREATE TABLE IF NOT EXISTS diagnostic_correlation (
        id BIGSERIAL PRIMARY KEY,
        date DATE NOT NULL,
        workspace_id TEXT,
        signal_category TEXT NOT NULL,
        correlated_metrics JSONB,
        severity TEXT,
        root_cause_hypothesis TEXT,
        confidence FLOAT,
        manual_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dc_date_ws ON diagnostic_correlation (date DESC, workspace_id)`,

      `CREATE TABLE IF NOT EXISTS diagnostic_external_factors (
        id BIGSERIAL PRIMARY KEY,
        date DATE NOT NULL,
        workspace_id TEXT,
        factor_type TEXT NOT NULL,
        description TEXT,
        regions_affected TEXT[],
        severity TEXT,
        expected_impact TEXT,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_def_date ON diagnostic_external_factors (date DESC)`,

      `CREATE TABLE IF NOT EXISTS daily_intelligence_logs (
        id BIGSERIAL PRIMARY KEY,
        date DATE NOT NULL,
        workspace_id TEXT,
        performance_tier TEXT,
        reply_rate FLOAT,
        bounce_rate FLOAT,
        warmup_pct FLOAT,
        api_health FLOAT,
        key_signals JSONB,
        correlated_patterns TEXT[],
        intelligence_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dil_date_ws ON daily_intelligence_logs (date DESC, workspace_id)`,

      `CREATE TABLE IF NOT EXISTS performance_patterns (
        id BIGSERIAL PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        pattern_value TEXT NOT NULL,
        workspace_id TEXT,
        avg_reply_rate FLOAT,
        avg_bounce_rate FLOAT,
        sample_size INT,
        correlation_strength FLOAT,
        last_updated TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pp_type ON performance_patterns (pattern_type)`,
      `CREATE INDEX IF NOT EXISTS idx_pp_value ON performance_patterns (pattern_value)`,

      `CREATE TABLE IF NOT EXISTS diagnostic_checks (
        id SERIAL PRIMARY KEY,
        check_name TEXT NOT NULL UNIQUE,
        metric_key TEXT NOT NULL,
        normal_min FLOAT,
        normal_max FLOAT,
        warning_min FLOAT,
        warning_max FLOAT,
        critical_min FLOAT,
        critical_max FLOAT,
        unit TEXT,
        description TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS suppressed_templates (
        workspace_id  TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        suppressed_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (workspace_id, content_hash)
      )`,

      // ── Client notes — persistent copy of the notes field so it
      // survives SQLite resets or migrations. Keyed by workspace_id.
      `CREATE TABLE IF NOT EXISTS client_notes (
        workspace_id TEXT PRIMARY KEY,
        notes        TEXT NOT NULL DEFAULT '',
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      // True MX provider per email domain, resolved by the verifier. MX is a
      // property of the domain, not the mailbox, so one lookup classifies the
      // whole company — cached here and fanned out to every contact on the
      // domain. Apollo's tech-stack guess is never written here; only a real
      // verifier MX result. provider ∈ ('email_google','email_outlook',
      // 'email_other'). Unresolvable MX is left uncached (contact stays NULL /
      // Unknown for a re-check), never recorded as a false 'other'. The lookup
      // index already exists as idx_contacts_email_domain (LOWER(SPLIT_PART(
      // email,'@',2))) above — domain-cache queries use that same expression.
      `CREATE TABLE IF NOT EXISTS domain_mx_cache (
        domain       TEXT PRIMARY KEY,
        mx_provider  TEXT NOT NULL,
        resolved_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // ── Companies House bulk-data tables ──────────────────────────
      `CREATE TABLE IF NOT EXISTS ch_companies (
        company_number TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        company_status TEXT,
        company_type TEXT,
        sic_codes TEXT,
        postcode TEXT,
        address_line1 TEXT,
        address_line2 TEXT,
        post_town TEXT,
        county TEXT,
        country TEXT,
        country_of_origin TEXT,
        incorporated_on TEXT,
        website TEXT,
        linkedin TEXT,
        employees TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ch_companies_sic ON ch_companies USING gin(string_to_array(sic_codes, ','))`,
      `CREATE INDEX IF NOT EXISTS idx_ch_companies_postcode ON ch_companies(postcode)`,
      `CREATE INDEX IF NOT EXISTS idx_ch_companies_status ON ch_companies(company_status)`,
      `CREATE TABLE IF NOT EXISTS ch_directors (
        id SERIAL PRIMARY KEY,
        company_number TEXT NOT NULL REFERENCES ch_companies(company_number) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT,
        appointed_on TEXT,
        resigned_on TEXT,
        address JSONB,
        email TEXT,
        email_status TEXT,
        email_verified_at TIMESTAMPTZ,
        pushed_to_bison_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_number, name, role)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ch_directors_company ON ch_directors(company_number)`,
      `CREATE INDEX IF NOT EXISTS idx_ch_directors_email ON ch_directors(email)`,
      `ALTER TABLE ch_directors ADD COLUMN IF NOT EXISTS dob_year_month TEXT`,
      `ALTER TABLE ch_companies ADD COLUMN IF NOT EXISTS industry TEXT`,
      `ALTER TABLE ch_companies ADD COLUMN IF NOT EXISTS keywords TEXT`,
      `ALTER TABLE ch_companies ADD COLUMN IF NOT EXISTS description TEXT`,
      `ALTER TABLE ch_companies ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`,
      `ALTER TABLE ch_companies ADD COLUMN IF NOT EXISTS domain_checked_at TIMESTAMPTZ`,

      // ── Website-scraping / enrichment tables ──────────────────────
      // The dashboard queues jobs here; the standalone scraper-service
      // worker (Easypanel, Crawlee/CheerioCrawler) claims and processes
      // them, writing results back to scraped_contacts. Schema MUST stay
      // in sync with apps/scraper-service/src/db.js (it self-migrates too).
      `CREATE TABLE IF NOT EXISTS scraped_contacts (
        domain         TEXT PRIMARY KEY,
        company_number TEXT,
        page_url       TEXT,
        emails         TEXT[] NOT NULL DEFAULT '{}',
        phones         TEXT[] NOT NULL DEFAULT '{}',
        raw_names      TEXT[] NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL DEFAULT 'ok',
        error_msg      TEXT,
        scraped_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_scraped_company ON scraped_contacts(company_number)`,
      `CREATE INDEX IF NOT EXISTS idx_scraped_at ON scraped_contacts(scraped_at)`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS website       TEXT`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS address       TEXT`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS business_type TEXT`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS industry      TEXT`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS keywords      TEXT[] NOT NULL DEFAULT '{}'`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS description   TEXT`,
      `ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS socials       JSONB`,

      `CREATE TABLE IF NOT EXISTS scrape_jobs (
        id          SERIAL PRIMARY KEY,
        label       TEXT,
        status      TEXT NOT NULL DEFAULT 'queued',
        total       INTEGER NOT NULL DEFAULT 0,
        done        INTEGER NOT NULL DEFAULT 0,
        ok          INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status)`,
      `ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ch'`,
      `ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS fields TEXT[]`,

      `CREATE TABLE IF NOT EXISTS scrape_job_items (
        id             SERIAL PRIMARY KEY,
        job_id         INTEGER NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
        company_number TEXT,
        company_name   TEXT,
        domain         TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_job_items_job ON scrape_job_items(job_id)`,
      `CREATE INDEX IF NOT EXISTS idx_job_items_status ON scrape_job_items(job_id, status)`,
      `ALTER TABLE scrape_job_items ADD COLUMN IF NOT EXISTS location TEXT`,
    ];

    // Migrations run with lock_timeout so a stuck previous-deploy query
    // can't block startup. ALTER TABLE needs an AccessExclusive lock.
    const mClient = await this.pool.connect();
    try {
      await mClient.query(`SET lock_timeout = '5s'`);
      for (const sql of migrations) {
        try { await mClient.query(sql); }
        catch (err) {
          if (!/already exists|lock timeout/i.test(err.message)) {
            console.warn('[PostgreSQL] Migration warning:', err.message.slice(0, 120));
          }
        }
      }
    } finally {
      mClient.release();
    }

    // Ads-checker columns on `contacts`. Deliberately NOT part of the migration
    // list above: that runner uses lock_timeout=5s and swallows lock-timeout
    // failures silently, which on a busy deploy left the columns missing and
    // turned the Contacts "Google Ads" filter into a 500. This retries around
    // the contention and records whether it succeeded, so _buildFilterClauses
    // can skip the filter instead of emitting SQL against a missing column.
    // Fire-and-forget: the retries back off for up to ~75s and must not block
    // app.listen().
    this._hasAdsColumns = false;
    require('./lib/adscheck/schema').ensureContactColumns(this)
      .then((ok) => { this._hasAdsColumns = ok; })
      .catch((e) => console.warn('[ads] contacts column check failed:', e.message));

    // Trigram indexes for fast substring ILIKE on the filter columns.
    // Each GIN build can scan the full contacts table — on a 25k+ row table
    // the six of these together can take minutes and block `app.listen()`.
    // Enable the extension synchronously (cheap), then fire-and-forget the
    // index builds so the dashboard starts serving immediately. Searches
    // remain correct meanwhile; they're just slower until the builds finish.
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      const trgmIndexes = [
        ['job_title',         `CREATE INDEX IF NOT EXISTS idx_contacts_job_title_trgm         ON contacts USING GIN (job_title gin_trgm_ops)`],
        ['job_title_cleaned', `CREATE INDEX IF NOT EXISTS idx_contacts_job_title_cleaned_trgm ON contacts USING GIN (job_title_cleaned gin_trgm_ops)`],
        ['industry',          `CREATE INDEX IF NOT EXISTS idx_contacts_industry_trgm          ON contacts USING GIN (industry gin_trgm_ops)`],
        ['keywords',          `CREATE INDEX IF NOT EXISTS idx_contacts_keywords_trgm          ON contacts USING GIN (keywords gin_trgm_ops)`],
        ['technologies',      `CREATE INDEX IF NOT EXISTS idx_contacts_technologies_trgm      ON contacts USING GIN (technologies gin_trgm_ops)`],
        ['company_name',      `CREATE INDEX IF NOT EXISTS idx_contacts_company_name_trgm     ON contacts USING GIN (company_name gin_trgm_ops)`],
        // B-tree on lowered email domain — catch-all propagation matches
        // by domain on every verify batch. Without this it was a full
        // 230k-row seq scan and held a pool connection for seconds.
        ['email_domain',      `CREATE INDEX IF NOT EXISTS idx_contacts_email_domain ON contacts (LOWER(SPLIT_PART(email, '@', 2)))`],
        // B-tree indexes for equality/range filters used on every saved view
        ['do_not_contact',   `CREATE INDEX IF NOT EXISTS idx_contacts_dnc ON contacts (do_not_contact) WHERE do_not_contact = false OR do_not_contact IS NULL`],
        // Ads checker. The partial index serves the "runs Google ads" grid
        // filter; the functional one is what the worker stamps against, matching
        // ads_domain_cache.domain (already lowercased, www-stripped) — without
        // it every finished job would seq-scan the whole contacts table.
        ['ads_runs_ads',     `CREATE INDEX IF NOT EXISTS idx_contacts_ads_runs_ads ON contacts (ads_runs_ads) WHERE ads_runs_ads IS NOT NULL`],
        ['ads_runs_ads',     `CREATE INDEX IF NOT EXISTS idx_contacts_domain_norm ON contacts (${DOMAIN_NORM_SQL})`],
        ['email_status',     `CREATE INDEX IF NOT EXISTS idx_contacts_email_status ON contacts (workspace_id, email_status)`],
        ['num_employees',    `CREATE INDEX IF NOT EXISTS idx_contacts_num_employees ON contacts (num_employees)`],
        ['country',          `CREATE INDEX IF NOT EXISTS idx_contacts_country ON contacts (LOWER(country))`],
        ['company_country',  `CREATE INDEX IF NOT EXISTS idx_contacts_company_country ON contacts (LOWER(company_country))`],
        ['city',             `CREATE INDEX IF NOT EXISTS idx_contacts_city ON contacts (LOWER(city))`],
        ['department',       `CREATE INDEX IF NOT EXISTS idx_contacts_department ON contacts (LOWER(department))`],
        // Additional missing indexes found in perf audit
        ['state',            `CREATE INDEX IF NOT EXISTS idx_contacts_state ON contacts (LOWER(state))`],
        ['company_city',     `CREATE INDEX IF NOT EXISTS idx_contacts_company_city ON contacts (LOWER(company_city))`],
        ['company_state',    `CREATE INDEX IF NOT EXISTS idx_contacts_company_state ON contacts (LOWER(company_state))`],
        // Normalised location hierarchy — these are the filter/split columns.
        ['company_region',   `CREATE INDEX IF NOT EXISTS idx_contacts_company_region ON contacts (LOWER(company_region))`],
        ['company_county',   `CREATE INDEX IF NOT EXISTS idx_contacts_company_county ON contacts (LOWER(company_county))`],
        ['company_town',     `CREATE INDEX IF NOT EXISTS idx_contacts_company_town ON contacts (LOWER(company_town))`],
        ['location_review',  `CREATE INDEX IF NOT EXISTS idx_contacts_location_review ON contacts (location_needs_review) WHERE location_needs_review = true`],
        ['works_remote',     `CREATE INDEX IF NOT EXISTS idx_contacts_works_remote ON contacts (works_remote)`],
        ['owns_building',    `CREATE INDEX IF NOT EXISTS idx_contacts_owns_building ON contacts (owns_building)`],
        // Resume gate for the CH re-verification job — shrinks toward empty as the
        // run completes, so "next unverified batch" scans stay O(batch) on 592k rows.
        ['ch_unverified',    `CREATE INDEX IF NOT EXISTS idx_contacts_ch_unverified ON contacts (id) WHERE ch_verified_at IS NULL`],
        ['exported_apollo',  `CREATE INDEX IF NOT EXISTS idx_contacts_exported_apollo ON contacts (exported_to_apollo_at)`],
        ['first_name',       `CREATE INDEX IF NOT EXISTS idx_contacts_first_name_trgm ON contacts USING GIN (first_name gin_trgm_ops)`],
        ['last_name',        `CREATE INDEX IF NOT EXISTS idx_contacts_last_name_trgm ON contacts USING GIN (last_name gin_trgm_ops)`],
        ['tags_gin',         `CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON contacts USING GIN (tags)`],
        // Per-client 60-day cooldown filter does `emailed_workspaces ? $ws`
        // on every search/count when a client is selected — jsonb_path_ops
        // makes that key-existence lookup index-backed.
        ['emailed_ws_gin',   `CREATE INDEX IF NOT EXISTS idx_contacts_emailed_workspaces_gin ON contacts USING GIN (emailed_workspaces jsonb_path_ops)`],
      ];
      // Build indexes in parallel batches of 3 — sequential builds took
      // 10+ minutes on 230K rows; parallel cuts that to ~3-4 min.
      // Pool can absorb 3 long-running builds while still serving traffic.
      (async () => {
        console.log('[PostgreSQL] Building indexes in background (3 in parallel)…');
        const t0 = Date.now();
        const BATCH = 3;
        for (let i = 0; i < trgmIndexes.length; i += BATCH) {
          const slice = trgmIndexes.slice(i, i + BATCH);
          await Promise.all(slice.map(async ([col, sql]) => {
            const s = Date.now();
            try {
              await this.pool.query(sql);
              console.log(`[PostgreSQL]   idx(${col}) ready in ${Date.now() - s}ms`);
            } catch (e) {
              console.warn(`[PostgreSQL]   idx(${col}) failed:`, e.message);
            }
          }));
        }
        console.log(`[PostgreSQL] All indexes done in ${Date.now() - t0}ms`);
      })();
    } catch (err) {
      console.warn('[PostgreSQL] pg_trgm unavailable, ILIKE filters will be slower:', err.message);
    }

    // Seed default mailbox pricing (only inserts rows that don't already
    // exist — so edits made in the UI aren't overwritten on restart).
    try {
      const defaults = [
        ['Winnr',    'smtp',      1.00, 'Winnr SMTP'],
        ['Maildoso', 'google',    2.50, 'Maildoso Google Admin'],
        ['Maildoso', 'microsoft', 2.50, 'Maildoso MS'],
        ['Mithun',   'microsoft', 1.00, 'Mithun MS Non-Admin'],
        ['Mithun',   'google',    2.50, 'Mithun Google Admin'],
        // Inboxing is billed as $30/month per domain (flat, up to 49
        // mailboxes under that domain). Unit cost is $0 here because the
        // $30/domain charge should be entered as a recurring expense on
        // the Finance page — that way it shows correctly regardless of
        // how many of the 49 slots are filled.
        ['Inboxing', 'microsoft', 0.00, 'Flat $30/domain/month — add as expense, not per-mailbox'],
        // Google Generic — generic Google mailboxes, $3.50/mailbox/month.
        ['Google Generic', 'google', 3.50, 'Google Generic — $3.50/mailbox/month'],
      ];
      for (const [supplier, type, cost, notes] of defaults) {
        await this.pool.query(
          `INSERT INTO mailbox_pricing (supplier, mailbox_type, unit_cost, notes)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (supplier, mailbox_type) DO UPDATE SET
             unit_cost = EXCLUDED.unit_cost,
             notes     = EXCLUDED.notes`,
          [supplier, type, cost, notes]
        );
      }
    } catch (err) {
      console.warn('[PostgreSQL] mailbox pricing seed skipped:', err.message);
    }

    // updated_at trigger — sent as a single intact statement so the
    // dollar-quoted PL/pgSQL body isn't shredded by the schema splitter.
    try {
      await this.pool.query(`
        CREATE OR REPLACE FUNCTION update_contacts_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await this.pool.query(`DROP TRIGGER IF EXISTS contacts_update_timestamp ON contacts`);
      await this.pool.query(`
        CREATE TRIGGER contacts_update_timestamp
        BEFORE UPDATE ON contacts
        FOR EACH ROW
        EXECUTE FUNCTION update_contacts_updated_at()
      `);
    } catch (err) {
      console.error('[PostgreSQL] trigger setup error:', err.message);
    }

    // Named saved views — store the filter-hash string verbatim so the
    // frontend's existing serializer is the single source of truth on shape.
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS saved_views (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          filters TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (workspace_id, name)
        );
      `);
    } catch (err) {
      console.error('[PostgreSQL] saved_views create error:', err.message);
    }

    // ── Placement Tests ───────────────────────────────────────────────
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS placement_seed_accounts (
        id           SERIAL PRIMARY KEY,
        label        TEXT NOT NULL,
        email        TEXT NOT NULL UNIQUE,
        imap_host    TEXT NOT NULL,
        imap_port    INT  NOT NULL DEFAULT 993,
        imap_user    TEXT NOT NULL,
        imap_password TEXT NOT NULL,
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS placement_smtp_accounts (
        id            SERIAL PRIMARY KEY,
        domain        TEXT NOT NULL UNIQUE,
        smtp_host     TEXT NOT NULL,
        smtp_port     INT  NOT NULL DEFAULT 587,
        smtp_user     TEXT NOT NULL,
        smtp_password TEXT NOT NULL,
        from_email    TEXT NOT NULL,
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS placement_tests (
        id           SERIAL PRIMARY KEY,
        domain       TEXT NOT NULL,
        seed_email   TEXT NOT NULL,
        subject      TEXT NOT NULL,
        sent_at      TIMESTAMP,
        result       TEXT,
        raw_folder   TEXT,
        checked_at   TIMESTAMP,
        triggered_by TEXT NOT NULL DEFAULT 'scheduled',
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_placement_tests_domain  ON placement_tests (domain)`,
      `CREATE INDEX IF NOT EXISTS idx_placement_tests_sent_at ON placement_tests (sent_at)`,
    ]) {
      try { await this.pool.query(sql); }
      catch (err) { console.error('[PostgreSQL] placement table error:', err.message); }
    }

    // One-shot data migrations tracked in _migrations so they never
    // re-run after completing. Previously these ran on every restart,
    // scanning the entire 230k-row contacts table each time (92+ seconds
    // for the location backfill alone), even when nothing had changed.
    // The whole IIFE is wrapped in a top-level catch so any unhandled
    // error here doesn't escape as an unhandled rejection and crash Node.
    (async () => {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
      } catch { /* ignore — table may already exist */ }

      const ran = async (name) => {
        try {
          const r = await this.pool.query(`SELECT 1 FROM _migrations WHERE name=$1`, [name]);
          return r.rows.length > 0;
        } catch { return false; } // if _migrations doesn't exist yet, treat as not-run
      };
      const mark = (name) => this.pool.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]).catch(() => {});

      // 1. Location / field backfill from Apollo raw_data
      if (!await ran('location-field-backfill-v1')) {
        try {
          const t0 = Date.now();
          await this.pool.query(`
            UPDATE contacts SET
              city            = NULLIF(TRIM(raw_data->>'City'), ''),
              state           = NULLIF(TRIM(raw_data->>'State'), ''),
              country         = NULLIF(TRIM(raw_data->>'Country'), ''),
              company_city    = NULLIF(TRIM(COALESCE(NULLIF(raw_data->>'Company City', ''), SPLIT_PART(raw_data->>'Company Address', ',', 2))), ''),
              company_state   = NULLIF(TRIM(COALESCE(NULLIF(raw_data->>'Company State', ''), SPLIT_PART(raw_data->>'Company Address', ',', 3))), ''),
              company_country = NULLIF(TRIM(COALESCE(NULLIF(raw_data->>'Company Country', ''), SPLIT_PART(raw_data->>'Company Address', ',', 4))), ''),
              linkedin_url    = NULLIF(TRIM(raw_data->>'Person Linkedin Url'), ''),
              industry        = NULLIF(TRIM(raw_data->>'Industry'), ''),
              technologies    = NULLIF(TRIM(raw_data->>'Technologies'), ''),
              keywords        = NULLIF(TRIM(raw_data->>'Keywords'), '')
            WHERE raw_data IS NOT NULL
              AND (city IS NULL OR company_city IS NULL OR linkedin_url IS NULL
                   OR (keywords IS NULL AND raw_data->>'Keywords' IS NOT NULL AND raw_data->>'Keywords' != ''))
          `);
          await mark('location-field-backfill-v1');
          console.log(`[PostgreSQL] Location/field backfill complete (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] Backfill error:', err.message); }
      }

      // 1b. Backfill keywords + technologies columns for contacts that missed
      //     the first pass (they had city/linkedin already so the v1 WHERE
      //     clause skipped them even though keywords was still NULL).
      if (!await ran('keywords-backfill-v1')) {
        try {
          const t0 = Date.now();
          const r = await this.pool.query(`
            UPDATE contacts
            SET keywords     = NULLIF(TRIM(raw_data->>'Keywords'), ''),
                technologies = NULLIF(TRIM(raw_data->>'Technologies'), '')
            WHERE raw_data IS NOT NULL
              AND (
                (keywords IS NULL AND raw_data->>'Keywords' IS NOT NULL AND raw_data->>'Keywords' != '')
                OR
                (technologies IS NULL AND raw_data->>'Technologies' IS NOT NULL AND raw_data->>'Technologies' != '')
              )
          `);
          await mark('keywords-backfill-v1');
          console.log(`[PostgreSQL] Keywords/technologies backfill: ${r.rowCount} rows updated (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] Keywords backfill error:', err.message); }
      }

      // 1c. Department / sub_departments backfill — the importer previously read
      //     "Department" (singular) but Apollo exports "Departments" (plural),
      //     so these columns were blank for all Apollo imports.
      if (!await ran('department-backfill-v2')) {
        try {
          const t0 = Date.now();
          let total = 0;
          // Run in batches of 10k to stay under the 120s statement timeout
          while (true) {
            const r = await this.pool.query(`
              UPDATE contacts SET
                department      = NULLIF(TRIM(COALESCE(NULLIF(raw_data->>'Departments',''),NULLIF(raw_data->>'Department',''),NULLIF(raw_data->>'department',''))),  ''),
                sub_departments = NULLIF(TRIM(COALESCE(NULLIF(raw_data->>'Sub Departments',''),NULLIF(raw_data->>'sub_departments',''))), '')
              WHERE id IN (
                SELECT id FROM contacts
                WHERE raw_data IS NOT NULL
                  AND ((department IS NULL AND (raw_data->>'Departments' != '' OR raw_data->>'Department' != '' OR raw_data->>'department' != ''))
                    OR (sub_departments IS NULL AND (raw_data->>'Sub Departments' != '' OR raw_data->>'sub_departments' != '')))
                LIMIT 10000
              )
            `);
            total += r.rowCount || 0;
            if ((r.rowCount || 0) < 10000) break;
          }
          await mark('department-backfill-v2');
          console.log(`[PostgreSQL] Department backfill: ${total} rows (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] Department backfill error:', err.message); }
      }

      // 2. num_employees from Apollo "# Employees" raw_data cell
      if (!await ran('num-employees-backfill-v1')) {
        try {
          const t0 = Date.now();
          const r = await this.pool.query(`
            UPDATE contacts
            SET num_employees = CASE
              WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*$'
                THEN regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\D', '', 'g')::int
              WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*-\\s*\\d+\\s*$'
                THEN split_part(regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\s', '', 'g'), '-', 1)::int
              WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*\\+\\s*$'
                THEN regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\D', '', 'g')::int
              ELSE NULL
            END
            WHERE num_employees IS NULL
              AND (raw_data->>'# Employees' IS NOT NULL OR raw_data->>'Employees' IS NOT NULL)
          `);
          await mark('num-employees-backfill-v1');
          console.log(`[PostgreSQL] num_employees backfilled for ${r.rowCount} rows (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] num_employees backfill error:', err.message); }
      }

      // 3. Company-name + job-title cleanup regex passes
      if (!await ran('company-name-job-title-clean-v1')) {
        try {
          const t0 = Date.now();
          await this.pool.query(`UPDATE contacts SET company_name = TRIM(REGEXP_REPLACE(company_name, '\\s+[-–—]\\s+.+$', '', 'g')) WHERE company_name LIKE '%-%' OR company_name LIKE '%–%'`);
          await this.pool.query(`UPDATE contacts SET company_name = TRIM(REGEXP_REPLACE(company_name, '\\s*\\([^)]*\\)', '', 'g')) WHERE company_name LIKE '%(%)%'`);
          await this.pool.query(`UPDATE contacts SET company_name = TRIM(REGEXP_REPLACE(company_name, '\\s+(Ltd\\.?|Inc\\.?|LLC\\.?|PLC|plc|Limited|Group|Holdings?|International|Solutions?|Services?|Consulting|Technologies?)\\s*$', '', 'gi')) WHERE company_name IS NOT NULL`);
          await this.pool.query(`UPDATE contacts SET job_title_cleaned = INITCAP(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(job_title, '\\s*\\([^)]*\\)', '', 'g'), '\\s*,\\s*.+$', '', 'g'), '\\s+[-–—]\\s+.+$', '', 'g'))) WHERE job_title IS NOT NULL`);
          await mark('company-name-job-title-clean-v1');
          console.log(`[PostgreSQL] Job titles and company names re-cleaned (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] Cleaning error:', err.message); }
      }

      // 4. Title-case ALL-CAPS company names left over from raw imports.
      //    Only touches MULTI-WORD all-caps strings ("DESIGNER CONTRACTS"
      //    → "Designer Contracts", "THE DOUBLE A" → "The Double A"). Single
      //    ALL-CAPS words like SIG / GSK / CITB are acronyms — left alone.
      //    Bumps statement_timeout to 10 min since this touches all 230k rows.
      // 4b. Strip ALL-CAPS leading "THE " — earlier v2 used '[Tt]he' which
      //     missed the uppercase form. Run BEFORE titlecase so "THE DOUBLE A"
      //     → "DOUBLE A" → (titlecase) → "Double A".
      if (!await ran('company-name-strip-the-allcaps-v1')) {
        try {
          const t0 = Date.now();
          const r = await this.pool.query(`
            UPDATE contacts
            SET company_name = TRIM(REGEXP_REPLACE(company_name, '^(THE|the|The)\\s+', '', ''))
            WHERE company_name ~ '^(THE|the|The)\\s'
          `);
          await mark('company-name-strip-the-allcaps-v1');
          console.log(`[PostgreSQL] Stripped leading "THE " from ${r.rowCount} company names (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] strip-the-allcaps error:', err.message); }
      }

      if (!await ran('company-name-titlecase-v2')) {
        try {
          const t0 = Date.now();
          await this.pool.query(`SET LOCAL statement_timeout = '600000'`).catch(() => {});
          const r = await this.pool.query(`
            UPDATE contacts
            SET company_name = INITCAP(company_name)
            WHERE company_name IS NOT NULL
              AND company_name !~ '[a-z]'      -- no lowercase anywhere
              AND company_name ~ '[A-Z]'       -- has at least one uppercase
              AND company_name ~ '\\s'         -- has whitespace → multi-word
          `);
          await mark('company-name-titlecase-v2');
          console.log(`[PostgreSQL] Title-cased ${r.rowCount} multi-word ALL-CAPS company names (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] Company titlecase v2 error:', err.message); }
      }

      // 5. Strip leading "The " + extended trailing suffixes (Trading,
      //    Enterprises, Industries, etc.). Runs as a separate migration so
      //    it applies to data already cleaned by v1.
      if (!await ran('company-name-clean-v2')) {
        try {
          const t0 = Date.now();
          // Strip leading "The "
          const r1 = await this.pool.query(`
            UPDATE contacts
            SET company_name = TRIM(REGEXP_REPLACE(company_name, '^[Tt]he\\s+', '', ''))
            WHERE company_name ~* '^the\\s+'
          `);
          // Strip extended trailing suffixes (case-insensitive, may be
          // followed by punctuation or end of string)
          const r2 = await this.pool.query(`
            UPDATE contacts
            SET company_name = TRIM(REGEXP_REPLACE(
              company_name,
              '[\\s,]+(Trading|Enterprises?|Industries|Manufacturing|Distribution|Logistics|Brands?|Worldwide|Global|Consultancy|Associates?|Partners?|Ventures?|Systems?)\\.?\\s*$',
              '',
              'gi'
            ))
            WHERE company_name ~* '\\s+(Trading|Enterprises?|Industries|Manufacturing|Distribution|Logistics|Brands?|Worldwide|Global|Consultancy|Associates?|Partners?|Ventures?|Systems?)\\.?\\s*$'
          `);
          await mark('company-name-clean-v2');
          console.log(`[PostgreSQL] company-name-clean-v2: stripped "The" on ${r1.rowCount}, suffixes on ${r2.rowCount} (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] company-name-clean-v2 error:', err.message); }
      }

      // 9. Repair campaign_templates.captured_at corrupted by the old upsert
      //    (which reset captured_at = now on every sync). Reset it to the
      //    earliest REAL send event for that template — the genuine "first ran"
      //    date that drives Copy's "Running since". Only moves dates BACKWARD
      //    to the truth (WHERE earliest_send < captured_at); never forward, so
      //    a template legitimately seen before its first recorded send keeps
      //    its real first-seen.
      if (!await ran('captured-at-from-first-send-v1')) {
        try {
          const t0 = Date.now();
          const r = await this.pool.query(`
            UPDATE campaign_templates ct
            SET captured_at = e.first_send
            FROM (
              SELECT workspace_id, content_hash, MIN(event_at) AS first_send
              FROM email_events
              WHERE content_hash IS NOT NULL AND event_type = 'sent'
              GROUP BY workspace_id, content_hash
            ) e
            WHERE ct.workspace_id = e.workspace_id
              AND ct.content_hash = e.content_hash
              AND e.first_send < ct.captured_at
          `);
          await mark('captured-at-from-first-send-v1');
          console.log(`[PostgreSQL] captured-at-from-first-send-v1: repaired ${r.rowCount} template rows (${Date.now() - t0}ms)`);
        } catch (err) { console.error('[PostgreSQL] captured-at-from-first-send-v1 error:', err.message); }
      }
    })().catch(err => console.error('[PostgreSQL] Migration IIFE error:', err.message));
  }

  async query(sql, params, opts = {}) {
    const client = await this.pool.connect();
    const raised = opts.statementTimeoutMs ? parseInt(opts.statementTimeoutMs, 10) : 0;
    try {
      // Optional per-statement timeout for bulk maintenance queries that need
      // longer than the pool's default 45s. Pooled connections are reused, so
      // we restore the default in finally to avoid leaking the raised timeout
      // to the next caller (SET LOCAL can't be used outside a transaction).
      if (raised) await client.query(`SET statement_timeout = ${raised}`);
      return await client.query(sql, params);
    } finally {
      if (raised) {
        try { await client.query(`SET statement_timeout = 45000`); } catch { /* connection may be dead */ }
      }
      client.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.initialized = false;
    }
  }

  // ── Contact Operations ──────────────────────────────────────

  async createContact(workspaceId, contactData) {
    const {
      email, firstName, lastName, phone, companyName, companyDomain,
      jobTitle, jobTitleCleaned, seniority, department, subDepartments,
      apolloId, apolloPersonId, linkedinUrl, industry, numEmployees,
      keywords, technologies, companyLinkedinUrl,
      city, state, country, companyAddress, companyCity, companyState, companyCountry,
      corporatePhone, companyPhone, emailVerifiedAt,
      source, rawData, tags
    } = contactData;

    const sql = `
      INSERT INTO contacts (
        workspace_id, email, first_name, last_name, phone,
        company_name, company_domain, job_title, job_title_cleaned,
        seniority, department, sub_departments, apollo_id, apollo_person_id,
        linkedin_url, industry, num_employees, keywords, technologies,
        company_linkedin_url, city, state, country,
        company_address, company_city, company_state, company_country,
        corporate_phone, company_phone, email_verified_at,
        source, raw_data, tags, imported_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,CURRENT_TIMESTAMP
      )
      ON CONFLICT (workspace_id, email)
      DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        phone = EXCLUDED.phone,
        company_name = EXCLUDED.company_name,
        company_domain = EXCLUDED.company_domain,
        job_title = EXCLUDED.job_title,
        job_title_cleaned = EXCLUDED.job_title_cleaned,
        seniority = EXCLUDED.seniority,
        department = EXCLUDED.department,
        sub_departments = EXCLUDED.sub_departments,
        apollo_id = EXCLUDED.apollo_id,
        linkedin_url = EXCLUDED.linkedin_url,
        industry = EXCLUDED.industry,
        num_employees = EXCLUDED.num_employees,
        keywords = EXCLUDED.keywords,
        technologies = EXCLUDED.technologies,
        company_linkedin_url = EXCLUDED.company_linkedin_url,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        country = EXCLUDED.country,
        company_address = EXCLUDED.company_address,
        company_city = EXCLUDED.company_city,
        company_state = EXCLUDED.company_state,
        company_country = EXCLUDED.company_country,
        corporate_phone = EXCLUDED.corporate_phone,
        company_phone = EXCLUDED.company_phone,
        email_verified_at = EXCLUDED.email_verified_at,
        raw_data = EXCLUDED.raw_data,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const result = await this.query(sql, [
      workspaceId, email, firstName, lastName, phone,
      companyName, companyDomain, jobTitle, jobTitleCleaned,
      seniority, department || null, subDepartments || null, apolloId, apolloPersonId,
      linkedinUrl || null, industry || null, numEmployees || null,
      keywords || null, technologies || null, companyLinkedinUrl || null,
      city || null, state || null, country || null,
      companyAddress || null, companyCity || null, companyState || null, companyCountry || null,
      corporatePhone || null, companyPhone || null, emailVerifiedAt || null,
      source, rawData ? JSON.stringify(rawData) : null, tags || []
    ]);

    return result.rows[0];
  }

  async getContact(workspaceId, email) {
    const sql = `
      SELECT * FROM contacts
      WHERE workspace_id = $1 AND email = $2
      LIMIT 1;
    `;
    const result = await this.query(sql, [workspaceId, email]);
    return result.rows[0];
  }

  async getContactById(id) {
    const sql = `
      SELECT email, first_name, last_name, phone, company_name, company_domain, job_title
      FROM contacts WHERE id = $1 LIMIT 1;
    `;
    const result = await this.query(sql, [id]);
    return result.rows[0];
  }

  async getContactsById(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const sql = `SELECT * FROM contacts WHERE id IN (${placeholders})`;
    const result = await this.query(sql, ids);
    return result.rows;
  }

  // Cached solar-qualification results, keyed by contact id. Only rows already
  // checked (solar_checked_at != NULL) are returned — the /enrich endpoint uses
  // these to skip re-spending Google calls on contacts done in a previous run.
  async getSolarResults(ids) {
    if (!ids || ids.length === 0) return {};
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const sql = `SELECT id, solar_checked_at, solar_status, solar_stop_reason, solar_max_kwp,
                   solar_panels, solar_annual_kwh, solar_roof_area_m2, solar_has_solar,
                   solar_lat, solar_lng, solar_roof_address, solar_maps_url, solar_imagery_date,
                   ccod_owns_building, ccod_building_owner, ccod_site_count
                 FROM contacts WHERE id IN (${placeholders}) AND solar_checked_at IS NOT NULL`;
    const result = await this.query(sql, ids);
    const out = {};
    for (const r of result.rows) out[String(r.id)] = r;
    return out;
  }

  // Just the QUALIFIED prospects among a set of ids (small result → fast refresh,
  // even when the id set is thousands). Filters in SQL, not in JS.
  async getSolarProspects(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const sql = `SELECT * FROM contacts WHERE id IN (${placeholders}) AND solar_status = 'qualified'`;
    const result = await this.query(sql, ids);
    return result.rows;
  }

  // Persist one solar-qualification result onto its contact so future runs reuse it.
  async saveSolarResult(id, rec) {
    if (!id) return;
    const num = (v) => (v == null || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
    await this.query(
      `UPDATE contacts SET
         solar_checked_at = NOW(),
         solar_status = $2, solar_stop_reason = $3,
         solar_max_kwp = $4, solar_panels = $5, solar_annual_kwh = $6, solar_roof_area_m2 = $7,
         solar_has_solar = $8, solar_lat = $9, solar_lng = $10,
         solar_roof_address = $11, solar_maps_url = $12, solar_imagery_date = $13
       WHERE id = $1`,
      [id, rec.status ?? null, rec.stop_reason ?? null,
       num(rec.max_system_kwp), num(rec.max_panels_fit), num(rec.est_annual_kwh), num(rec.roof_area_m2),
       rec.has_solar ?? null, num(rec.lat), num(rec.lng),
       rec.roof_address_used ?? null, rec.maps_url ?? null, rec.imagery_date ?? null]
    );
  }

  _buildFilterClauses(filters) {
    const params = [];
    let p = 2;
    const clauses = [];

    const like = (col, val) => { clauses.push(`${col} ILIKE $${p++}`); params.push(`%${val}%`); };
    const eq   = (col, val) => { clauses.push(`${col} = $${p++}`); params.push(val); };
    // Comma-separated → IN (...). Single value falls through to eq for an index-friendly plan.
    const eqMulti = (col, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      if (values.length === 1) { eq(col, values[0]); return; }
      const placeholders = values.map(() => `$${p++}`).join(',');
      clauses.push(`${col} IN (${placeholders})`);
      params.push(...values);
    };
    const jsonbMulti = (field, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      const patterns = values.map(v => `%${v}%`);
      clauses.push(`(raw_data->>'${field}' ILIKE ANY($${p}))`);
      params.push(patterns);
      p++;
    };
    const jsonbExclude = (field, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      const patterns = values.map(v => `%${v}%`);
      clauses.push(`(raw_data->>'${field}' IS NULL OR raw_data->>'${field}' NOT ILIKE ALL($${p}))`);
      params.push(patterns);
      p++;
    };
    // Match a comma-separated value list against one or more real columns
    // (faster than the JSONB equivalents, and works for both Apollo and
    // PlusVibe rows because both importers populate these columns).
    // Collapses N values into a single `col ILIKE ANY(ARRAY[...])` expression
    // — one parameter, one per-row eval, planner-friendly. Was previously N
    // chained OR clauses which timed out on big Apollo URLs (60+ keywords).
    // Escape regex metacharacters so a user value like "real estate (b2b)" is
    // matched literally, not as a regex. Used to build word-boundary patterns.
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Build a case-insensitive whole-word regex from one or more values:
    //   ['cat','dog'] -> '\y(cat|dog)\y'
    // \y is Postgres's word boundary, so "cat" matches "cat" / "cat food" but
    // NOT "education". Punctuation in the field still bounds words, so
    // "real estate" matches inside "Real Estate & Property".
    const wordRegex = (values) => `\\y(${values.map(reEsc).join('|')})\\y`;

    const colMulti = (cols, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      const colsArr = Array.isArray(cols) ? cols : [cols];
      // Whole-word match (was substring ILIKE %val%, which wrongly matched
      // "cat" inside "eduCATion"). ~* is case-insensitive regex.
      const orClauses = colsArr.map(c => `${c} ~* $${p}`);
      clauses.push(`(${orClauses.join(' OR ')})`);
      params.push(wordRegex(values));
      p++;
    };
    // Exact-match variant for normalised fields (region/county/town).
    // Uses LOWER() = ANY() so the LOWER() btree index is hit — no wildcard
    // scan needed since these are clean normalised values.
    const colExact = (col, val) => {
      const values = val.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`LOWER(${col}) = ANY($${p})`);
      params.push(values);
      p++;
    };
    const colExclude = (cols, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      const colsArr = Array.isArray(cols) ? cols : [cols];
      // Whole-word exclusion (matches colMulti): excluding "cat" must not also
      // exclude "education". A row passes if NONE of its columns contain any
      // excluded value as a whole word. NULL column = no match = row passes.
      const perCol = colsArr.map(c => `(${c} IS NULL OR ${c} !~* $${p})`);
      clauses.push(`(${perCol.join(' AND ')})`);
      params.push(wordRegex(values));
      p++;
    };
    // Exact-match exclusion — the negative counterpart of colExact (used by the
    // normalised region/county/town filters). A row passes if the column is
    // NULL or its lowercased value is none of the excluded values.
    const colExactExclude = (col, val) => {
      const values = val.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`(${col} IS NULL OR LOWER(${col}) <> ALL($${p}))`);
      params.push(values);
      p++;
    };

    // Apply each filter inside a `safe()` wrapper so one bad value (malformed
    // range, weird unicode, etc.) doesn't abort the whole search. Failed
    // filters are logged and skipped; the rest still apply.
    const safe = (name, fn) => {
      try { fn(); }
      catch (e) { console.warn(`[search] filter "${name}" skipped:`, e.message); }
    };

    safe('status',     () => { if (filters.status)     eq('status', filters.status); });
    safe('seniority',  () => { if (filters.seniority)  eqMulti('seniority', filters.seniority); });
    safe('firstName',  () => { if (filters.firstName)  like('first_name', filters.firstName); });
    safe('lastName',   () => { if (filters.lastName)   like('last_name', filters.lastName); });
    // Use the denormalised columns (populated by the CSV importer for both
    // Apollo and PlusVibe rows) instead of raw_data->>'…' JSONB scans. This
    // is 10–100× faster on big batches of ORs and avoids Apollo-only
    // column-name assumptions.
    safe('jobTitle',            () => { if (filters.jobTitle)            colMulti(['job_title','job_title_cleaned'], filters.jobTitle); });
    safe('jobTitleExclude',     () => { if (filters.jobTitleExclude)     colExclude(['job_title','job_title_cleaned'], filters.jobTitleExclude); });
    safe('department',          () => { if (filters.department)          colMulti('department', filters.department); });
    safe('subDepartments',      () => { if (filters.subDepartments)      colMulti('sub_departments', filters.subDepartments); });
    safe('linkedinUrl',         () => { if (filters.linkedinUrl)         like('linkedin_url', filters.linkedinUrl); });
    safe('industry',            () => { if (filters.industry)            colMulti('industry', filters.industry); });
    safe('industryExclude',     () => { if (filters.industryExclude)     colExclude('industry', filters.industryExclude); });
    // keywords/technologies: search the dedicated column first, fall back to
    // raw_data JSONB for contacts imported before the column was backfilled.
    safe('keywords', () => {
      if (!filters.keywords) return;
      const values = filters.keywords.split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      // Whole-word match (was substring) — see colMulti/wordRegex.
      clauses.push(`COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') ~* $${p}`);
      params.push(wordRegex(values)); p++;
    });
    safe('keywordsExclude', () => {
      if (!filters.keywordsExclude) return;
      const values = filters.keywordsExclude.split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`(COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') IS NULL OR COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') !~* $${p})`);
      params.push(wordRegex(values)); p++;
    });
    safe('technologies', () => {
      if (!filters.technologies) return;
      const values = filters.technologies.split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') ~* $${p}`);
      params.push(wordRegex(values)); p++;
    });
    safe('technologiesExclude', () => {
      if (!filters.technologiesExclude) return;
      const values = filters.technologiesExclude.split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`(COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') IS NULL OR COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') !~* $${p})`);
      params.push(wordRegex(values)); p++;
    });
    // Companies House SIC codes — the precise "what does this company legally do"
    // signal. Apollo keywords tag any company *adjacent* to a sector (brokers,
    // suppliers, recruiters), so SIC is how you isolate e.g. real care homes
    // (87100/87300/87900) from companies that merely mention them.
    // ch_sic_codes is a comma-joined string like "87300,88100". Each requested
    // code matches HIERARCHICALLY: it anchors at a token boundary and then any
    // remaining digits of the full code may follow, so "43" matches 43, 431,
    // 43100, 43210… (the whole SIC division), while a full "87300" still only
    // matches 87300 (the trailing-digits group can be empty). This lets you
    // enter a division/group prefix and pull everything beneath it.
    safe('sicCodes', () => {
      if (!filters.sicCodes) return;
      const codes = filters.sicCodes.split(',').map(c => c.trim()).filter(Boolean);
      if (!codes.length) return;
      clauses.push(`ch_sic_codes ~* $${p}`);
      params.push(`(^|,)(${codes.map(c => c.replace(/[^0-9]/g,'')).join('|')})[0-9]*(,|$)`); p++;
    });
    safe('website',             () => { if (filters.website)             like('company_domain', filters.website); });
    safe('companyLinkedin',     () => { if (filters.companyLinkedin)     like('company_linkedin_url', filters.companyLinkedin); });
    // Location filters are multi-select — comma-separated values must OR
    // against the column, not be glued together as a single substring.
    safe('city',          () => { if (filters.city)          colMulti('city',            filters.city); });
    safe('state',         () => { if (filters.state)         colMulti('state',           filters.state); });
    safe('country',       () => { if (filters.country)       colMulti('country',         filters.country); });
    safe('companyCity',   () => { if (filters.companyCity)   colMulti('company_city',    filters.companyCity); });
    safe('companyState',  () => { if (filters.companyState)  colMulti('company_state',   filters.companyState); });
    safe('companyCountry',() => { if (filters.companyCountry)colMulti('company_country', filters.companyCountry); });
    // Google Ads Transparency (stamped by the ads checker — see lib/adscheck).
    //   yes / no      → known to run ads / known not to
    //   checked       → any result, regardless of outcome
    //   unchecked     → never been through the ads checker
    // Plus an optional minimum ad count, to isolate the heavier advertisers.
    // Guarded by _hasAdsColumns: the ALTERs that add these can lose a lock race
    // on the busy contacts table, and referencing a missing column turns the
    // WHOLE contacts search into a 500 rather than just ignoring one filter.
    // A filter that quietly does nothing is far better than a dead grid.
    safe('adsRunsAds', () => {
      if (!this._hasAdsColumns) return;
      const v = String(filters.adsRunsAds || '').toLowerCase();
      if (v === 'yes')            clauses.push('ads_runs_ads IS TRUE');
      else if (v === 'no')        clauses.push('ads_runs_ads IS FALSE');
      else if (v === 'checked')   clauses.push('ads_checked_at IS NOT NULL');
      else if (v === 'unchecked') clauses.push('ads_checked_at IS NULL');
    });
    safe('adsMinCount', () => {
      if (!this._hasAdsColumns) return;
      const n = parseInt(filters.adsMinCount, 10);
      if (Number.isFinite(n)) { clauses.push(`ads_count >= $${p}`); params.push(n); p++; }
    });
    safe('adsMaxCount', () => {
      if (!this._hasAdsColumns) return;
      const n = parseInt(filters.adsMaxCount, 10);
      if (Number.isFinite(n)) { clauses.push(`ads_count <= $${p}`); params.push(n); p++; }
    });

    // Normalised location hierarchy filters — the clean split/filter columns.
    safe('companyRegion', () => { if (filters.companyRegion) colExact('company_region',  filters.companyRegion); });
    safe('companyCounty', () => { if (filters.companyCounty) colExact('company_county',  filters.companyCounty); });
    safe('companyTown',   () => { if (filters.companyTown)   colExact('company_town',    filters.companyTown); });
    safe('personRegion',  () => { if (filters.personRegion)  colExact('person_region',   filters.personRegion); });
    safe('personCounty',  () => { if (filters.personCounty)  colExact('person_county',   filters.personCounty); });
    safe('personTown',    () => { if (filters.personTown)    colExact('person_town',     filters.personTown); });
    safe('locationNeedsReview', () => { if (filters.locationNeedsReview === 'true') clauses.push('location_needs_review = true'); });
    // Per-client master exclusions — also match the company-side columns so
    // "London" hides both person-in-London and company-in-London rows.
    safe('cityExclude',   () => { if (filters.cityExclude)   colExclude(['city','company_city'],          filters.cityExclude); });
    safe('stateExclude',  () => { if (filters.stateExclude)  colExclude(['state','company_state'],        filters.stateExclude); });
    safe('countryExclude',() => { if (filters.countryExclude)colExclude(['country','company_country'],    filters.countryExclude); });
    // Person normalised-location excludes (exact match, mirroring their includes).
    safe('personRegionExclude', () => { if (filters.personRegionExclude) colExactExclude('person_region', filters.personRegionExclude); });
    safe('personCountyExclude', () => { if (filters.personCountyExclude) colExactExclude('person_county', filters.personCountyExclude); });
    safe('personTownExclude',   () => { if (filters.personTownExclude)   colExactExclude('person_town',   filters.personTownExclude); });
    // Company-location excludes. City/State/Country are whole-word (match their
    // colMulti includes); region/county/town are exact (match their colExact).
    safe('companyCityExclude',    () => { if (filters.companyCityExclude)    colExclude('company_city',       filters.companyCityExclude); });
    safe('companyStateExclude',   () => { if (filters.companyStateExclude)   colExclude('company_state',      filters.companyStateExclude); });
    safe('companyCountryExclude', () => { if (filters.companyCountryExclude) colExclude('company_country',    filters.companyCountryExclude); });
    safe('companyRegionExclude',  () => { if (filters.companyRegionExclude)  colExactExclude('company_region', filters.companyRegionExclude); });
    safe('companyCountyExclude',  () => { if (filters.companyCountyExclude)  colExactExclude('company_county', filters.companyCountyExclude); });
    safe('companyTownExclude',    () => { if (filters.companyTownExclude)    colExactExclude('company_town',   filters.companyTownExclude); });
    safe('email',         () => { if (filters.email)         like('email', filters.email); });
    safe('phone',         () => { if (filters.phone)         { clauses.push(`(corporate_phone ILIKE $${p} OR company_phone ILIKE $${p})`); params.push(`%${filters.phone}%`); p++; } });
    safe('company',       () => { if (filters.company)       { clauses.push(`(company_name ILIKE $${p} OR company_domain ILIKE $${p})`); params.push(`%${filters.company}%`); p++; } });
    safe('search',        () => { if (filters.search)        { clauses.push(`(email ILIKE $${p} OR first_name ILIKE $${p} OR last_name ILIKE $${p} OR company_name ILIKE $${p})`); params.push(`%${filters.search}%`); p++; } });
    // Tag filter — match contacts whose tags[] array overlaps any given tag.
    // Comma-separated; uses the GIN index (tags && ARRAY[...]). Lets you filter
    // to a named scrape batch (the batch name is stored as a tag) or 'ch_scraper'.
    safe('tags',          () => {
      if (!filters.tags) return;
      const values = String(filters.tags).split(',').map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      clauses.push(`tags && $${p}::text[]`);
      params.push(values);
      p++;
    });
    // Source filter (e.g. 'ch_scraper', 'apollo_csv') — exact match on source col.
    safe('source',        () => { if (filters.source) eqMulti('source', filters.source); });

    // Verification status filter — multi-select values from email_status column.
    // 'not_verified' is a synthetic value mapped to IS NULL.
    safe('emailStatus', () => {
      if (!filters.emailStatus) return;
      const statuses = filters.emailStatus.split(',').map(s => s.trim()).filter(Boolean);
      if (!statuses.length) return;
      const ors = [];
      const realStatuses = statuses.filter(s => s !== 'not_verified');
      if (realStatuses.length) {
        const ph = realStatuses.map(() => `$${p++}`).join(',');
        ors.push(`email_status IN (${ph})`);
        params.push(...realStatuses);
      }
      if (statuses.includes('not_verified')) ors.push(`email_status IS NULL`);
      if (ors.length) clauses.push(`(${ors.join(' OR ')})`);
    });

    safe('emailProviders', () => {
      if (!filters.emailProviders) return;
      const providers = filters.emailProviders.split(',').map(prov => prov.trim()).filter(Boolean);
      if (!providers.length) return;
      // Provider is the TRUE MX provider only — never Apollo's tech-stack
      // guess (tags/technologies), which is what leaked Microsoft contacts
      // past a "Google + Other" filter. A contact matches a provider iff its
      // mx_provider equals it. Contacts with an unknown MX (mx_provider IS
      // NULL) deliberately match no provider here: they still appear via the
      // 'unknown' pseudo-provider below so they can be pushed-then-verified,
      // and the push-time gate enforces the real provider once the verifier
      // stamps it. MX is a domain property, so domain_mx_cache backfills
      // mx_provider for every contact on a domain once any one resolves.
      const orClauses = [];
      for (const prov of providers) {
        if (prov === 'unknown') {
          // Not-yet-verified contacts — no true MX yet. Surfaced so the user
          // can push them through the verifier to discover the real provider.
          orClauses.push(`mx_provider IS NULL`);
        } else {
          orClauses.push(`mx_provider = $${p}`);
          params.push(prov);
          p += 1;
        }
      }
      clauses.push(`(${orClauses.join(' OR ')})`);
    });

    // Default-ON Microsoft guard. Drops Microsoft-hosted contacts AND not-yet-
    // verified ones (mx_provider IS NULL — could be Microsoft hiding behind a
    // gateway). This is the fix for MS leaking into Bison: an unverified domain
    // that turns out to be Microsoft can no longer slip through. Verify first
    // (mx-scan) to reveal the true provider, then the Google/Other remainder is
    // safe to push. Untick "Exclude Microsoft & unverified" to override.
    safe('excludeMicrosoft', () => {
      if (filters.excludeMicrosoft !== 'true' && filters.excludeMicrosoft !== true) return;
      clauses.push(`mx_provider IS NOT NULL AND mx_provider <> 'email_outlook'`);
    });

    // Gateway filter — by the TRUE inbound gateway (Mimecast/Proofpoint/Barracuda/
    // Microsoft 365/Google/…) resolved into gateway_mx_cache, joined on the email
    // domain. `gatewayExclude` drops contacts on the named gateways (the common
    // case: "don't push to Mimecast"); `gateway` keeps only the named ones.
    // Comma-separated gateway names exactly as stored in gateway_mx_cache.gateway.
    // Contacts whose domain isn't cached are NOT excluded (we can't prove their
    // gateway) — so excluding never silently drops unknown-gateway contacts.
    safe('gatewayExclude', () => {
      if (!filters.gatewayExclude) return;
      const gws = filters.gatewayExclude.split(',').map(g => g.trim()).filter(Boolean);
      if (!gws.length) return;
      clauses.push(`lower(split_part(email,'@',2)) NOT IN (
        SELECT domain FROM gateway_mx_cache WHERE gateway = ANY($${p}))`);
      params.push(gws);
      p += 1;
    });
    safe('gateway', () => {
      if (!filters.gateway) return;
      const gws = filters.gateway.split(',').map(g => g.trim()).filter(Boolean);
      if (!gws.length) return;
      clauses.push(`lower(split_part(email,'@',2)) IN (
        SELECT domain FROM gateway_mx_cache WHERE gateway = ANY($${p}))`);
      params.push(gws);
      p += 1;
    });

    safe('numEmployeesRanges', () => {
      if (!filters.numEmployeesRanges) return;
      const buckets = filters.numEmployeesRanges.split(',').map(s => s.trim()).filter(Boolean);
      const ors = [];
      for (const b of buckets) {
        if (b === 'unknown') {
          ors.push(`num_employees IS NULL`);
        } else {
          const m = b.match(/^(\d+)\s*-\s*(\d+)?$/) || b.match(/^(\d+)\+$/);
          if (!m) continue;
          const lo = parseInt(m[1], 10);
          const hi = m[2] ? parseInt(m[2], 10) : null;
          if (hi == null) {
            ors.push(`num_employees >= $${p}`); params.push(lo); p++;
          } else {
            ors.push(`num_employees BETWEEN $${p} AND $${p+1}`); params.push(lo, hi); p += 2;
          }
        }
      }
      if (ors.length) clauses.push(`(${ors.join(' OR ')})`);
    });

    // Per-client master exclusion — hide rows whose num_employees falls
    // into any of the listed buckets. Same bucket grammar as the include
    // filter ("1-10", "11-50", "1000+"). NULL employees are kept unless
    // 'unknown' is listed (consistency with the include side).
    safe('numEmployeesExcludeRanges', () => {
      if (!filters.numEmployeesExcludeRanges) return;
      const buckets = filters.numEmployeesExcludeRanges.split(',').map(s => s.trim()).filter(Boolean);
      const ors = [];
      for (const b of buckets) {
        if (b === 'unknown') {
          ors.push(`num_employees IS NULL`);
        } else {
          const m = b.match(/^(\d+)\s*-\s*(\d+)?$/) || b.match(/^(\d+)\+$/);
          if (!m) continue;
          const lo = parseInt(m[1], 10);
          const hi = m[2] ? parseInt(m[2], 10) : null;
          if (hi == null) {
            ors.push(`num_employees >= $${p}`); params.push(lo); p++;
          } else {
            ors.push(`num_employees BETWEEN $${p} AND $${p+1}`); params.push(lo, hi); p += 2;
          }
        }
      }
      if (ors.length) clauses.push(`NOT (${ors.join(' OR ')})`);
    });

    // Intelligence filters
    safe('ownsBuilding',   () => { if (filters.ownsBuilding) { clauses.push(`owns_building = $${p++}`); params.push(filters.ownsBuilding); } });

    // Companies House enrichment, populated by the Common Crawl lead pipeline.
    // Age band is a coarse bucket ("legacy (25y+)") rather than a raw number so
    // it can be picked from a list; company_age_years is kept for range queries.
    safe('companyAgeBand', () => { if (filters.companyAgeBand) eqMulti('company_age_band', filters.companyAgeBand); });
    safe('companyStatus',  () => { if (filters.companyStatus)  eqMulti('company_status',  filters.companyStatus); });
    // Land Registry freehold, matched on company_number rather than the postcode
    // sweep above. A freeholder can authorise solar or roofing work; a
    // leaseholder generally cannot.
    safe('ownsFreehold',   () => {
      const v = filters.ownsFreehold;
      if (!v) return;
      if (v === 'yes') clauses.push(`owns_freehold IS TRUE`);
      else if (v === 'no') clauses.push(`(owns_freehold IS FALSE OR owns_freehold IS NULL)`);
    });
    // Whether the Companies House match was corroborated by name or postcode.
    // Unverified rows still carry a valid email — they just have no CH-derived
    // fields, so exclude them when personalising on company or director name.
    safe('chVerified',     () => {
      const v = filters.chVerified;
      if (!v) return;
      if (v === 'yes') clauses.push(`ch_verified IS TRUE`);
      else if (v === 'no') clauses.push(`(ch_verified IS FALSE OR ch_verified IS NULL)`);
    });

    // Land Registry (CCOD) ownership sweep result — separate from the manual
    // owns_building signal above. Special values: 'checked'/'unchecked' filter
    // on whether the sweep has run; anything else matches ccod_owns_building.
    safe('ccodOwnsBuilding', () => {
      const v = filters.ccodOwnsBuilding;
      if (!v) return;
      if (v === 'checked')        clauses.push(`ccod_checked_at IS NOT NULL`);
      else if (v === 'unchecked') clauses.push(`ccod_checked_at IS NULL`);
      else { clauses.push(`ccod_owns_building = $${p++}`); params.push(v); }
    });

    // Solar-qualification result (from the Solar page, persisted to solar_* columns).
    safe('solarStatus', () => {
      const v = filters.solarStatus;
      if (!v) return;
      if (v === 'prospect')          clauses.push(`solar_status = 'qualified'`);
      else if (v === 'roof_small')   clauses.push(`solar_stop_reason LIKE 'roof_too_small%'`);
      else if (v === 'tenant')       clauses.push(`solar_stop_reason = 'tenant'`);
      else if (v === 'already_solar')clauses.push(`solar_has_solar = 'yes'`);
      else if (v === 'checked')      clauses.push(`solar_checked_at IS NOT NULL`);
      else if (v === 'unchecked')    clauses.push(`solar_checked_at IS NULL`);
    });
    // Minimum solar system size (kWp) — e.g. only PPA-worthy 100kWp+ prospects.
    safe('solarMinKwp', () => {
      const n = parseInt(filters.solarMinKwp, 10);
      if (!Number.isFinite(n) || n <= 0) return;
      clauses.push(`solar_max_kwp >= $${p++}`); params.push(n);
    });
    // Data age — filter by how fresh the contact is. "last N days" = recently
    // touched; "staleN" = NOT touched in N days (or never). Uses the most recent of
    // updated_at / created_at so a contact that's never been updated still sorts by
    // when it was added.
    safe('updatedAge', () => {
      const v = filters.updatedAge;
      if (!v) return;
      const recent = { '7':7, '30':30, '90':90, '180':180 };
      const stale  = { 'stale90':90, 'stale180':180, 'stale365':365 };
      const age = `COALESCE(updated_at, created_at)`;
      if (recent[v]) { clauses.push(`${age} >= now() - ($${p++}::int * interval '1 day')`); params.push(recent[v]); }
      else if (stale[v]) { clauses.push(`(${age} IS NULL OR ${age} < now() - ($${p++}::int * interval '1 day'))`); params.push(stale[v]); }
    });
    safe('worksRemote',    () => { if (filters.worksRemote === 'true')   clauses.push(`works_remote = true`); });
    safe('excludeRemote',  () => { if (filters.excludeRemote === 'true') clauses.push(`(works_remote IS NULL OR works_remote = false)`); });
    safe('excludeDNC',     () => { if (filters.excludeDNC === 'true')    clauses.push(`(do_not_contact IS NULL OR do_not_contact = false)`); });

    // Apollo export filter
    safe('notExportedToApollo', () => { if (filters.notExportedToApollo === 'true') clauses.push(`exported_to_apollo_at IS NULL`); });
    safe('exportedToApollo',    () => { if (filters.exportedToApollo === 'true')    clauses.push(`exported_to_apollo_at IS NOT NULL`); });

    // PlusVibe push filter — emailed_workspaces JSONB gets a key per workspace
    // when the contact has been pushed to a campaign there. Empty {} = never sent.
    safe('sentToPV',    () => { if (filters.sentToPV === 'true')    clauses.push(`COALESCE(emailed_workspaces, '{}'::jsonb) != '{}'::jsonb`); });
    safe('notSentToPV', () => { if (filters.notSentToPV === 'true') clauses.push(`COALESCE(emailed_workspaces, '{}'::jsonb) = '{}'::jsonb`); });

    // Companies House filters
    safe('chStatus',      () => { if (filters.chStatus) { clauses.push(`company_status = $${p++}`); params.push(filters.chStatus); } });
    safe('chInsolvency',  () => { if (filters.chInsolvency === 'true')  clauses.push(`ch_has_insolvency = true`); });
    safe('chCharges',     () => { if (filters.chCharges === 'true')     clauses.push(`ch_has_charges = true`); });
    safe('chOverdue',     () => { if (filters.chOverdue === 'true')     clauses.push(`ch_accounts_overdue = true`); });
    safe('chOnlyEnriched',() => { if (filters.chOnlyEnriched === 'true') clauses.push(`ch_company_number IS NOT NULL`); });

    safe('vertical', () => {
      if (!filters.vertical) return;
      const v = filters.vertical;
      const today = new Date().toISOString().slice(0, 10);
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(snoozed_verticals, '[]'::jsonb)) AS sv
        WHERE sv->>'vertical' = $${p} AND sv->>'until' >= $${p+1}
      )`);
      params.push(v, today); p += 2;
      if (v === 'solar') { clauses.push(`owns_building = $${p++}`); params.push('yes'); }
      if (v === 'office_furniture') { clauses.push(`(works_remote IS NULL OR works_remote = false)`); }
    });

    // Per-client 60-day cooldown — hide contacts already pushed/emailed to this
    // workspace in the last 60 days. Mirrors the push-time filter in
    // /api/pv/push-contacts so users don't see rows that would just be
    // silently skipped on push. last_sent is stored as YYYY-MM-DD string
    // (stamped at push time + updated by webhook), so lexicographic comparison works.
    safe('cooldownWorkspace', () => {
      if (!filters.cooldownWorkspace) return;
      const cooloffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      clauses.push(`NOT (
        emailed_workspaces ? $${p}
        AND COALESCE(emailed_workspaces->$${p}->>'last_sent', '') >= $${p+1}
      )`);
      params.push(filters.cooldownWorkspace, cooloffDate);
      p += 2;
    });

    return { clauses, params };
  }

  async searchContacts(workspaceId, filters, limit = 100, offset = 0) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    const allowedSort = ['created_at','email','first_name','last_name','company_name','seniority','status','exported_to_apollo_at'];
    const sortField = allowedSort.includes(filters.sortBy) ? filters.sortBy : 'created_at';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    const p = params.length + 2;
    let sql;
    if (filters.maxPerCompany && filters.maxPerCompany > 0) {
      // Window-function cap: take at most N rows per company_name (NULL
      // company_name treated as its own bucket via COALESCE).
      sql = `
        WITH ranked AS (
          SELECT id, workspace_id, email, first_name, last_name, phone, company_name, company_domain,
            job_title, job_title_cleaned, seniority, department, sub_departments, apollo_id, apollo_person_id,
            linkedin_url, company_linkedin_url, industry, num_employees, keywords, technologies,
            city, state, country, company_address, company_city, company_state, company_country,
            company_region, company_county, company_town,
            person_region, person_county, person_town,
            location_source, location_needs_review, location_review_reason,
            corporate_phone, company_phone, email_status, email_verified_at,
            status, tags, source, do_not_contact, works_remote, owns_building,
            ccod_owns_building, ccod_building_owner, ccod_site_count, ccod_checked_at,
            ch_company_number, ch_postcode,
            snoozed_verticals, reply_notes, last_reply_at, marked_as_lead_at,
            bounced_at, bounce_type, soft_bounce_count, last_emailed_at, email_count,
            emailed_workspaces, last_campaign_name, pushed_campaigns,
            exported_to_apollo_at, imported_at, created_at, updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(COALESCE(company_name, email))
              ORDER BY ${sortField} ${sortDir}
            ) AS _rn
          FROM contacts
          WHERE workspace_id = $1${where}
        )
        SELECT * FROM ranked
        WHERE _rn <= $${p}
        ORDER BY ${sortField} ${sortDir}
        LIMIT $${p + 1} OFFSET $${p + 2}
      `;
      const result = await this.query(sql, [workspaceId, ...params, filters.maxPerCompany, limit, offset]);
      return result.rows;
    }
    sql = `SELECT id, workspace_id, email, first_name, last_name, phone, company_name, company_domain,
      job_title, job_title_cleaned, seniority, department, sub_departments, apollo_id, apollo_person_id,
      linkedin_url, company_linkedin_url, industry, num_employees, keywords, technologies,
      city, state, country, company_address, company_city, company_state, company_country,
      corporate_phone, company_phone, email_status, email_verified_at,
      status, tags, source, do_not_contact, works_remote, owns_building,
      ccod_owns_building, ccod_building_owner, ccod_site_count, ccod_checked_at,
      ch_company_number, ch_postcode,
      snoozed_verticals, reply_notes, last_reply_at, marked_as_lead_at,
      bounced_at, bounce_type, soft_bounce_count, last_emailed_at, email_count,
      emailed_workspaces, last_campaign_name, pushed_campaigns,
      exported_to_apollo_at, imported_at, created_at, updated_at
      FROM contacts WHERE workspace_id = $1${where} ORDER BY ${sortField} ${sortDir} LIMIT $${p} OFFSET $${p + 1}`;
    const result = await this.query(sql, [workspaceId, ...params, limit, offset]);
    return result.rows;
  }

  // Lightweight export query — only the 6 columns Apollo needs.
  // Bypasses searchContacts to avoid ORDER BY + raw_data overhead on large
  // filtered sets (company_region filter on 267k rows was timing out).
  // Unconditional cleanliness guard applied to EVERY CSV export + its count, so
  // no dead / risky / suppressed address can ever leave in a downloadable file.
  // Only verifier-clean (safe / safe_catchall), not opted-out, not hard-bounced.
  // This is non-negotiable — there is no flag to turn it off.
  static EXPORT_CLEAN_SQL = `
    AND LOWER(COALESCE(email_status,'')) IN ('safe','safe_catchall')
    AND COALESCE(do_not_contact, false) = false
    AND COALESCE(LOWER(bounce_type),'') <> 'hard'
    AND email LIKE '%@%'`;

  // When includeUnverified is set, the deliverability guard is lifted — export
  // ALL matching contacts (any verification status) so Apollo can enrich/verify
  // them. We still require a real address and never export opted-out contacts.
  static EXPORT_MINIMAL_SQL = `
    AND email LIKE '%@%'
    AND COALESCE(do_not_contact, false) = false`;
  static _guard(includeUnverified) {
    return includeUnverified ? PostgresDatabase.EXPORT_MINIMAL_SQL : PostgresDatabase.EXPORT_CLEAN_SQL;
  }

  async exportContacts(workspaceId, filters = {}, limit = 1000, offset = 0, includeUnverified = false) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
    const p = params.length + 2;
    const sql = `
      SELECT id, first_name, last_name, email, company_name, company_domain,
             apollo_id
      FROM contacts
      WHERE workspace_id = $1${where}${PostgresDatabase._guard(includeUnverified)}
      ORDER BY id
      LIMIT $${p} OFFSET $${p + 1}`;
    return await this._runExportQuery(sql, [workspaceId, ...params, limit, offset]);
  }

  // Keyset-paginated export page: fetch up to `limit` exportable rows with id >
  // afterId in id order. The predicate is a full scan, but running it ONCE per
  // file (limit = whole file) is ~1.8s even for 60k rows — vs the old loop that
  // re-ran a 1000-row OFFSET query per chunk (dozens of scans → 60s timeout).
  // Chaining files by last id (keyset) avoids OFFSET's skip cost entirely.
  async exportContactsPage(workspaceId, filters = {}, limit = 100000, afterId = null, includeUnverified = false) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
    let sql = `
      SELECT id, first_name, last_name, email, company_name, company_domain,
             apollo_id
      FROM contacts
      WHERE workspace_id = $1${where}${PostgresDatabase._guard(includeUnverified)}`;
    const args = [workspaceId, ...params];
    if (afterId) { sql += ` AND id > $${args.length + 1}`; args.push(afterId); }
    sql += ` ORDER BY id LIMIT $${args.length + 1}`;
    args.push(limit);
    // A large export is a big cold bitmap-heap scan — on the prod server that
    // reads enough uncached pages to blow the pool's 45s statement_timeout
    // (worst on includeUnverified, ~4x the rows). Run on a dedicated client with
    // a raised timeout so the export finishes instead of 500-ing.
    return await this._runExportQuery(sql, args);
  }

  // Run an export query on its own client with a 5-minute statement_timeout, then
  // reset the timeout before returning the client to the pool.
  async _runExportQuery(sql, args) {
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = '300000'`);
      const result = await client.query(sql, args);
      return result.rows;
    } finally {
      try { await client.query(`SET statement_timeout = 45000`); } catch { /* connection may be dead */ }
      client.release();
    }
  }

  async getContactsCount(workspaceId, filters = {}) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    // 30s cache. COUNT(*) across 230k+ rows with filters is the single
    // most expensive part of a search request (full-table scan + filter
    // eval), and it runs in parallel with the actual page fetch on every
    // filter tweak / pagination click. Total count rarely changes
    // second-to-second, so this is safe and cuts search CPU roughly in half.
    const cacheKey = 'cnt|' + workspaceId + '|' + where + '|' + params.join('|');
    if (!this._filterCountCache) this._filterCountCache = new Map();
    const now = Date.now();
    const cached = this._filterCountCache.get(cacheKey);
    if (cached && now - cached.ts < 30000) return cached.value;

    const sql = `SELECT COUNT(*) as count FROM contacts WHERE workspace_id = $1${where}`;
    const result = await this.query(sql, [workspaceId, ...params]);
    const count = parseInt(result.rows[0].count, 10);
    this._filterCountCache.set(cacheKey, { value: count, ts: now });
    return count;
  }

  // Count of EXPORTABLE contacts (same filters + the export cleanliness guard as
  // exportContacts). The Apollo export paginates over this clean set, so the loop
  // MUST count against the same guard — using getContactsCount (no guard) inflated
  // the total and made X-Has-More loop past the real end into empty/wrong pages.
  async getExportableCount(workspaceId, filters = {}, includeUnverified = false) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
    const sql = `SELECT COUNT(*) as count FROM contacts
      WHERE workspace_id = $1${where}${PostgresDatabase._guard(includeUnverified)}`;
    // Raised-timeout client — a cold count over a broad unverified filter can
    // exceed the 45s pool timeout on prod.
    const rows = await this._runExportQuery(sql, [workspaceId, ...params]);
    return parseInt(rows[0].count, 10);
  }

  async bulkCreateContacts(workspaceId, contacts) {
    // Postgres rejects ON CONFLICT DO UPDATE if the same target row is hit
    // twice in one statement, so we must dedupe by email before batching.
    // PlusVibe exports routinely contain repeats (one row per campaign send).
    // Last occurrence wins, matching upsert semantics.
    const seen = new Map();
    let withinBatchDupes = 0;
    for (const c of contacts) {
      const key = (c.email || '').toLowerCase();
      if (!key) continue;
      if (seen.has(key)) withinBatchDupes++;
      seen.set(key, c);
    }
    const unique = Array.from(seen.values());

    // Insert in batches of 1000 for efficiency
    const batchSize = 1000;
    let inserted = 0;   // genuinely new rows
    let updated = 0;    // existing rows refreshed

    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      const values = [];
      const placeholders = [];

      const COLS = 40;
      batch.forEach((contact, idx) => {
        const offset = idx * COLS;
        const ph = Array.from({ length: COLS }, (_, k) => `$${offset + k + 1}`).join(',');
        // Two trailing literals: imported_at, location_normalized_at.
        placeholders.push(`(${ph}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

        const {
          email, firstName, lastName, phone, companyName, companyDomain,
          jobTitle, jobTitleCleaned, seniority, apolloId,
          city, state, country, companyCity, companyState, companyCountry,
          source, rawData, tags,
          linkedinUrl, companyLinkedinUrl, industry, department, subDepartments, companyAddress,
          lastEmailedAt, lastCampaignName, numEmployees,
          keywords, technologies,
          // Normalised location hierarchy (from location-normalizer)
          companyCityNorm, companyRegion, companyCounty, companyTown,
          personRegion, personCounty, personTown,
          locationSource, locationNeedsReview, locationReviewReason
        } = contact;

        values.push(
          workspaceId, email, firstName || null, lastName || null, phone || null,
          companyName || null, companyDomain || null, jobTitle || null,
          jobTitleCleaned || null, seniority || null,
          apolloId || null,
          city || null, state || null, country || null,
          // company_city uses the cleaned post town when available
          (companyCityNorm || companyCity) || null, companyState || null, companyCountry || null,
          source || 'api', rawData ? JSON.stringify(rawData) : null, tags || [],
          linkedinUrl || null, companyLinkedinUrl || null, industry || null,
          department || null, subDepartments || null, companyAddress || null,
          lastEmailedAt || null, lastCampaignName || null,
          Number.isFinite(numEmployees) ? numEmployees : null,
          keywords || null, technologies || null,
          companyRegion || null, companyCounty || null, companyTown || null,
          personRegion || null, personCounty || null, personTown || null,
          locationSource || null, !!locationNeedsReview, locationReviewReason || null
        );
      });

      const sql = `
        INSERT INTO contacts (
          workspace_id, email, first_name, last_name, phone,
          company_name, company_domain, job_title, job_title_cleaned,
          seniority, apollo_id,
          city, state, country,
          company_city, company_state, company_country,
          source, raw_data, tags,
          linkedin_url, company_linkedin_url, industry, department, sub_departments, company_address,
          last_emailed_at, last_campaign_name, num_employees,
          keywords, technologies,
          company_region, company_county, company_town,
          person_region, person_county, person_town,
          location_source, location_needs_review, location_review_reason,
          imported_at, location_normalized_at
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (workspace_id, email) DO UPDATE SET
          first_name          = COALESCE(NULLIF(EXCLUDED.first_name, ''), contacts.first_name),
          last_name           = COALESCE(NULLIF(EXCLUDED.last_name, ''), contacts.last_name),
          phone               = COALESCE(NULLIF(EXCLUDED.phone, ''), contacts.phone),
          company_name        = COALESCE(NULLIF(EXCLUDED.company_name, ''), contacts.company_name),
          company_domain      = COALESCE(NULLIF(EXCLUDED.company_domain, ''), contacts.company_domain),
          job_title           = COALESCE(NULLIF(EXCLUDED.job_title, ''), contacts.job_title),
          job_title_cleaned   = COALESCE(NULLIF(EXCLUDED.job_title_cleaned, ''), contacts.job_title_cleaned),
          seniority           = COALESCE(NULLIF(EXCLUDED.seniority, ''), contacts.seniority),
          apollo_id           = COALESCE(NULLIF(EXCLUDED.apollo_id, ''), contacts.apollo_id),
          city                = COALESCE(NULLIF(EXCLUDED.city, ''), contacts.city),
          state               = COALESCE(NULLIF(EXCLUDED.state, ''), contacts.state),
          country             = COALESCE(NULLIF(EXCLUDED.country, ''), contacts.country),
          company_city        = COALESCE(NULLIF(EXCLUDED.company_city, ''), contacts.company_city),
          company_state       = COALESCE(NULLIF(EXCLUDED.company_state, ''), contacts.company_state),
          company_country     = COALESCE(NULLIF(EXCLUDED.company_country, ''), contacts.company_country),
          -- Normalised location: a fresh import re-derives the hierarchy, so
          -- prefer the incoming values whenever the new import produced one.
          company_region      = COALESCE(NULLIF(EXCLUDED.company_region, ''), contacts.company_region),
          company_county      = COALESCE(NULLIF(EXCLUDED.company_county, ''), contacts.company_county),
          company_town        = COALESCE(NULLIF(EXCLUDED.company_town, ''), contacts.company_town),
          person_region       = COALESCE(NULLIF(EXCLUDED.person_region, ''), contacts.person_region),
          person_county       = COALESCE(NULLIF(EXCLUDED.person_county, ''), contacts.person_county),
          person_town         = COALESCE(NULLIF(EXCLUDED.person_town, ''), contacts.person_town),
          location_source     = COALESCE(NULLIF(EXCLUDED.location_source, ''), contacts.location_source),
          location_needs_review = EXCLUDED.location_needs_review,
          location_review_reason = EXCLUDED.location_review_reason,
          location_normalized_at = CURRENT_TIMESTAMP,
          linkedin_url        = COALESCE(NULLIF(EXCLUDED.linkedin_url, ''), contacts.linkedin_url),
          company_linkedin_url= COALESCE(NULLIF(EXCLUDED.company_linkedin_url, ''), contacts.company_linkedin_url),
          industry            = COALESCE(NULLIF(EXCLUDED.industry, ''), contacts.industry),
          department          = COALESCE(NULLIF(EXCLUDED.department, ''), contacts.department),
          sub_departments     = COALESCE(NULLIF(EXCLUDED.sub_departments, ''), contacts.sub_departments),
          company_address     = COALESCE(NULLIF(EXCLUDED.company_address, ''), contacts.company_address),
          keywords            = COALESCE(NULLIF(EXCLUDED.keywords, ''), contacts.keywords),
          technologies        = COALESCE(NULLIF(EXCLUDED.technologies, ''), contacts.technologies),
          -- Only advance last_emailed_at; never blank it out. Take the max
          -- of incoming and existing so a stale CSV row can't hide a more
          -- recent send recorded later.
          last_emailed_at     = GREATEST(EXCLUDED.last_emailed_at, contacts.last_emailed_at),
          last_campaign_name  = COALESCE(NULLIF(EXCLUDED.last_campaign_name, ''), contacts.last_campaign_name),
          num_employees       = COALESCE(EXCLUDED.num_employees, contacts.num_employees),
          raw_data            = EXCLUDED.raw_data,
          tags                = EXCLUDED.tags,
          updated_at          = CURRENT_TIMESTAMP
        RETURNING (xmax = 0) AS inserted;
      `;

      try {
        const result = await this.query(sql, values);
        for (const r of result.rows) {
          if (r.inserted) inserted++; else updated++;
        }
      } catch (err) {
        console.error('[PostgreSQL] Batch insert error:', err.message);
      }
    }

    // `created` kept for backward-compat with the import endpoint, which adds
    // it to job.imported. We want it to mean "newly inserted" only now.
    return { created: inserted, inserted, updated, withinBatchDupes };
  }

  // ── Saved views ─────────────────────────────────────────────
  async listSavedViews(workspaceId) {
    const r = await this.query(
      `SELECT id, name, filters, updated_at FROM saved_views
        WHERE workspace_id = $1 ORDER BY LOWER(name)`,
      [workspaceId]
    );
    return r.rows;
  }

  // Upsert by (workspace_id, name) so saving with an existing name overwrites
  // — matches how users mentally model "save view".
  async saveView(workspaceId, name, filters) {
    const r = await this.query(
      `INSERT INTO saved_views (workspace_id, name, filters)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         filters = EXCLUDED.filters,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, name, filters, updated_at`,
      [workspaceId, name, filters]
    );
    return r.rows[0];
  }

  async deleteSavedView(workspaceId, id) {
    const r = await this.query(
      `DELETE FROM saved_views WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    return r.rowCount || 0;
  }

  // Bulk update email verification results
  async updateContactIntelligence(contactId, fields) {
    const allowed = ['works_remote','owns_building','do_not_contact','snoozed_verticals','reply_notes','last_reply_at','marked_as_lead_at','bounced_at'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map((k, i) => `${k} = $${i + 2}`);
    if (!sets.length) return 0;
    const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k =>
      typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]
    );
    const result = await this.query(
      `UPDATE contacts SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id = $1`,
      [contactId, ...vals]
    );
    return result.rowCount || 0;
  }

  async bulkUpdateVerification(updates, opts = {}) {
    // updates = [{ id, email_status, email_verified_at, email? }]
    // opts.skipCatchAllPropagation — write verdicts, defer domain propagation
    // opts.propagateOnly             — skip the verdict UPDATE, only propagate
    if (!updates.length) return 0;

    if (!opts.propagateOnly) {
      // Sort by id so concurrent batches acquire row locks in the same
      // order, preventing the cross-deadlocks we hit when two verify-and-push
      // jobs touched overlapping rows.
      const sorted = [...updates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      // Chunk so any single UPDATE holds locks for a bounded time — webhooks
      // and exports running in parallel were waiting >30s and timing out.
      const BATCH = 1000;
      const now = new Date().toISOString();
      for (let i = 0; i < sorted.length; i += BATCH) {
        const slice = sorted.slice(i, i + BATCH);
        const vals = [];
        const placeholders = slice.map((u, j) => {
          const base = j * 4;
          vals.push(u.id, u.email_status, u.email_verified_at || now, u.mx_provider || null);
          return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4})`;
        });
        await this.query(`
          UPDATE contacts SET
            email_status      = v.status,
            email_verified_at = v.verified_at::timestamp,
            -- True MX provider → authoritative mx_provider column. This is what
            -- the provider filter now reads. A null new value means the verifier
            -- couldn't resolve MX this run; keep any known-good value rather than
            -- wiping it to Unknown (re-checks happen on the next verify).
            mx_provider       = COALESCE(v.mx_provider, contacts.mx_provider),
            -- Keep the legacy tag in sync for display, but it is no longer used
            -- for filtering.
            tags = CASE
              WHEN v.mx_provider IS NOT NULL THEN
                array_append(
                  array_remove(array_remove(array_remove(
                    COALESCE(tags, ARRAY[]::text[]),
                    'email_google'), 'email_outlook'), 'email_other'),
                  v.mx_provider)
              ELSE tags
            END,
            updated_at        = CURRENT_TIMESTAMP
          FROM (VALUES ${placeholders.join(',')}) AS v(id, status, verified_at, mx_provider)
          WHERE contacts.id = v.id::uuid
        `, vals);
      }
    }

    if (opts.skipCatchAllPropagation) return updates.length;

    // Domain-level catch-all propagation: if any mailbox on a domain is
    // risky (catch-all), every other contact at that domain is also risky
    // by definition — the domain accepts all addresses.
    //
    // Build the risky-domain list from THIS batch's risky updates only, so
    // we don't re-scan the entire contacts table on every verification job.
    // Then propagate in id-ordered chunks with SKIP LOCKED so we never
    // deadlock with another writer holding a row we want.
    const riskyEmails = updates
      .filter(u => u.email_status === 'risky' && u.email)
      .map(u => u.email);
    if (riskyEmails.length) {
      const domains = [...new Set(
        riskyEmails.map(e => (e.split('@')[1] || '').toLowerCase()).filter(Boolean)
      )];
      if (domains.length) {
        let propagatedTotal = 0;
        while (true) {
          const r = await this.query(`
            UPDATE contacts
            SET email_status = 'risky', updated_at = CURRENT_TIMESTAMP
            WHERE id IN (
              SELECT id FROM contacts
              WHERE email_status IS NULL
                AND LOWER(SPLIT_PART(email, '@', 2)) = ANY($1::text[])
              ORDER BY id
              LIMIT 2000
              FOR UPDATE SKIP LOCKED
            )
          `, [domains]);
          const n = r.rowCount || 0;
          propagatedTotal += n;
          if (n < 2000) break;
        }
        if (propagatedTotal > 0) {
          console.log(`[Verification] Catch-all propagated to ${propagatedTotal} additional contact(s)`);
        }
      }
    }

    return updates.length;
  }

  async backfillLocations(workspaceId) {
    // Chunked so a 200k-row workspace doesn't hit the 45s statement_timeout.
    // The WHERE clause only matches rows where a destination column is NULL
    // AND raw_data has a non-empty value for it — guarantees termination
    // because each touched row stops matching after the update. COALESCE in
    // the SET preserves any already-populated columns instead of overwriting
    // them with NULL when raw_data is missing that key.
    const BATCH = 1000;
    let total = 0;
    while (true) {
      const result = await this.query(`
        UPDATE contacts SET
          city            = COALESCE(city,            NULLIF(TRIM(raw_data->>'City'), '')),
          state           = COALESCE(state,           NULLIF(TRIM(raw_data->>'State'), '')),
          country         = COALESCE(country,         NULLIF(TRIM(raw_data->>'Country'), '')),
          company_city    = COALESCE(company_city,    NULLIF(TRIM(COALESCE(
                              NULLIF(raw_data->>'Company City', ''),
                              SPLIT_PART(raw_data->>'Company Address', ',', 2)
                            )), '')),
          company_state   = COALESCE(company_state,   NULLIF(TRIM(COALESCE(
                              NULLIF(raw_data->>'Company State', ''),
                              SPLIT_PART(raw_data->>'Company Address', ',', 3)
                            )), '')),
          company_country = COALESCE(company_country, NULLIF(TRIM(COALESCE(
                              NULLIF(raw_data->>'Company Country', ''),
                              SPLIT_PART(raw_data->>'Company Address', ',', 4)
                            )), '')),
          updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT id FROM contacts
          WHERE workspace_id = $1 AND raw_data IS NOT NULL
            AND (
              (city            IS NULL AND TRIM(COALESCE(raw_data->>'City', '')) != '') OR
              (state           IS NULL AND TRIM(COALESCE(raw_data->>'State', '')) != '') OR
              (country         IS NULL AND TRIM(COALESCE(raw_data->>'Country', '')) != '') OR
              (company_city    IS NULL AND (TRIM(COALESCE(raw_data->>'Company City', '')) != ''
                                            OR TRIM(COALESCE(SPLIT_PART(raw_data->>'Company Address', ',', 2), '')) != '')) OR
              (company_state   IS NULL AND (TRIM(COALESCE(raw_data->>'Company State', '')) != ''
                                            OR TRIM(COALESCE(SPLIT_PART(raw_data->>'Company Address', ',', 3), '')) != '')) OR
              (company_country IS NULL AND (TRIM(COALESCE(raw_data->>'Company Country', '')) != ''
                                            OR TRIM(COALESCE(SPLIT_PART(raw_data->>'Company Address', ',', 4), '')) != ''))
            )
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
      `, [workspaceId, BATCH]);
      const n = result.rowCount || 0;
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  async deleteNoNameContacts(workspaceId) {
    const result = await this.query(
      `DELETE FROM contacts WHERE workspace_id = $1
       AND (first_name IS NULL OR first_name = '')
       AND (last_name IS NULL OR last_name = '')`,
      [workspaceId]
    );
    return result.rowCount || 0;
  }

  async updateContactStatus(workspaceId, email, status) {
    const sql = `
      UPDATE contacts
      SET status = $3, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = $1 AND email = $2
      RETURNING *;
    `;
    const result = await this.query(sql, [workspaceId, email, status]);
    return result.rows[0];
  }

  // ── Campaign Operations ──────────────────────────────────────

  async createCampaign(workspaceId, name, description) {
    const sql = `
      INSERT INTO campaigns (workspace_id, name, description)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const result = await this.query(sql, [workspaceId, name, description]);
    return result.rows[0];
  }

  async addContactsToCampaign(campaignId, contactIds) {
    if (!contactIds.length) return 0;

    const values = [];
    const placeholders = [];

    contactIds.forEach((id, idx) => {
      placeholders.push(`($1, $${idx + 2})`);
      values.push(campaignId, id);
    });

    const sql = `
      INSERT INTO campaign_contacts (campaign_id, contact_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT DO NOTHING;
    `;

    const result = await this.query(sql, [campaignId, ...contactIds]);
    return result.rowCount || 0;
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  async getWorkspaceSummary(workspaceId) {
    const sql = `
      SELECT
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN status = 'new' THEN 1 END) as new_contacts,
        COUNT(CASE WHEN status = 'interested' THEN 1 END) as interested,
        COUNT(CASE WHEN status = 'replied' THEN 1 END) as replied,
        COUNT(CASE WHEN status = 'bounced' THEN 1 END) as bounced,
        COUNT(DISTINCT company_domain) as unique_companies
      FROM contacts
      WHERE workspace_id = $1;
    `;
    const result = await this.query(sql, [workspaceId]);
    return result.rows[0];
  }

  async getDistinctValues(workspaceId, field, limit = 100) {
    // Filter dropdowns (Industry, Keywords, Role, Company, Location…) all call
    // this. On the 590k-row contacts table the unnest+group can exceed the
    // statement timeout — intermittently, depending on workspace size and DB
    // load — and the catch below returns [] → the dropdown shows "No results".
    // That's the "sometimes they show, sometimes not" symptom.
    //
    // Cache results per (workspace, field, limit) with a TTL so repeat opens are
    // instant and never re-run the heavy query. On a timeout/error we fall back
    // to the last good cached value (stale-but-useful) rather than blanking the
    // dropdown. These distinct sets change slowly, so a few minutes is fine.
    this._distinctCache = this._distinctCache || new Map();
    const cacheKey = `${workspaceId}:${field}:${limit}`;
    const TTL_MS = 10 * 60 * 1000;
    const cached = this._distinctCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < TTL_MS) return cached.values;

    let values;
    try {
      values = await this._getDistinctValuesUncached(workspaceId, field, limit);
    } catch (err) {
      console.error(`getDistinctValues failed for ${field}:`, err.message);
      values = null;
    }
    // A timeout / cold cache returns [] (or null) — NEVER cache an empty result
    // (it would blank the dropdown for the whole TTL even after data lands). Only
    // cache non-empty results; serve a prior cached value if this run came back
    // empty but we had one.
    if (!values || values.length === 0) return cached ? cached.values : [];
    this._distinctCache.set(cacheKey, { values, at: Date.now() });
    return values;
  }

  async _getDistinctValuesUncached(workspaceId, field, limit = 100) {
    // Map of table columns (fast query)
    const tableColumns = {
      'job_title':      'job_title',
      'jobTitle':       'job_title_cleaned',
      'seniority':      'seniority',
      'status':         'status',
      'company_name':   'company_name',
      'company_domain': 'company_domain',
      'industry':       'industry',
      // Person location
      'city': 'city', 'state': 'state', 'country': 'country',
      // Company location
      'company_city': 'company_city', 'company_state': 'company_state', 'company_country': 'company_country',
      // Normalised location hierarchy (Country>Region>County>City>Town)
      'company_region': 'company_region', 'company_county': 'company_county', 'company_town': 'company_town',
      'person_region':  'person_region',  'person_county':  'person_county',  'person_town':  'person_town',
      'department': 'department',
    };

    const tableColumn = tableColumns[field];
    if (tableColumn) {
      const sql = `
        SELECT ${tableColumn} as value, COUNT(*) as count
        FROM contacts
        WHERE workspace_id = $2
          AND ${tableColumn} IS NOT NULL AND ${tableColumn} != ''
        GROUP BY ${tableColumn}
        ORDER BY count DESC, ${tableColumn}
        LIMIT $1;
      `;
      const result = await this.query(sql, [limit, workspaceId]);
      return result.rows.filter(r => r.value).map(r => ({
        value: r.value,
        count: parseInt(r.count, 10)
      }));
    }

    // Comma-separated fields: split into individual values.
    // Read from the dedicated column (keywords / technologies) AND the raw_data
    // JSONB fallback — some contacts were imported before the column was backfilled.
    const commaSeparatedFields = {
      'Keywords':     { col: 'keywords',     raw: 'Keywords' },
      'Technologies': { col: 'technologies', raw: 'Technologies' },
    };
    if (commaSeparatedFields[field]) {
      const { col } = commaSeparatedFields[field];
      // The live unnest+GROUP over ~590k comma-list rows takes ~90s (Keywords),
      // so it blew the HTTP timeout and the dropdown showed nothing. We now serve
      // these from a precomputed table (contacts_distinct_cache), refreshed
      // periodically by refreshDistinctCache(). That read is a fast indexed scan.
      const cached = await this.query(
        `SELECT value, count FROM contacts_distinct_cache
         WHERE workspace_id = $1 AND field = $2
         ORDER BY count DESC LIMIT $3`,
        [workspaceId, field, limit]
      );
      if (cached.rows.length) {
        return cached.rows.map(r => ({ value: r.value, count: parseInt(r.count, 10) }));
      }
      // Cold cache (never refreshed yet): kick off a refresh in the background so
      // the NEXT open is populated, and return empty for now rather than hanging
      // the request on the 90s live query.
      this.refreshDistinctCache(workspaceId, field).catch(e =>
        console.error(`[distinct-cache] background refresh ${field} failed:`, e.message));
      return [];
    }

    // Extract from JSONB raw_data for any CSV column
    const jsonField = field.replace('_', ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const sql = `
      SELECT raw_data->>'${jsonField}' as value, COUNT(*) as count
      FROM contacts
      WHERE workspace_id = $2
        AND raw_data->>'${jsonField}' IS NOT NULL AND raw_data->>'${jsonField}' != ''
      GROUP BY raw_data->>'${jsonField}'
      ORDER BY count DESC, value
      LIMIT $1;
    `;

    try {
      const result = await this.query(sql, [limit, workspaceId]);
      return result.rows.filter(r => r.value).map(r => ({
        value: r.value,
        count: parseInt(r.count, 10)
      }));
    } catch (err) {
      // Re-throw so getDistinctValues can fall back to the last cached value
      // rather than blanking the dropdown on a transient timeout.
      console.error(`Error extracting ${field} from raw_data:`, err.message);
      throw err;
    }
  }

  // Recompute the distinct-value cache for the heavy comma-list fields
  // (Keywords / Technologies). The live unnest+GROUP is ~90s, so we run it on a
  // raised-timeout client, in the background, and refresh the cache table the
  // dropdown reads from. Called on startup + on an interval, and lazily when a
  // field's cache is empty. Top 10k values per field is plenty for autocomplete.
  async refreshDistinctCache(workspaceId = 'ottaly-global', onlyField = null) {
    const fields = { Keywords: 'keywords', Technologies: 'technologies' };
    const targets = onlyField ? { [onlyField]: fields[onlyField] } : fields;
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = '300000'`); // 5 min for the heavy scan
      for (const [field, col] of Object.entries(targets)) {
        if (!col) continue;
        const t0 = Date.now();
        // Stamp every row this run writes with the SAME timestamp, captured
        // before the INSERT, so the prune below can safely delete only rows this
        // run did NOT refresh — never the whole field on a partial/slow run.
        const { rows: [{ now: runTs }] } = await client.query(`SELECT NOW() AS now`);
        const ins = await client.query(
          `INSERT INTO contacts_distinct_cache (workspace_id, field, value, count, refreshed_at)
           SELECT $1, $2, trim(val), COUNT(*)::int, $3::timestamptz
           FROM contacts c CROSS JOIN LATERAL unnest(string_to_array(c.${col}, ',')) AS val
           WHERE c.workspace_id = $1 AND c.${col} IS NOT NULL AND c.${col} <> '' AND trim(val) <> ''
           GROUP BY trim(val) ORDER BY COUNT(*) DESC LIMIT 10000
           ON CONFLICT (workspace_id, field, value)
           DO UPDATE SET count = EXCLUDED.count, refreshed_at = $3::timestamptz`,
          [workspaceId, field, runTs]
        );
        // Only prune if the INSERT actually wrote rows — otherwise leave the
        // existing cache intact (a failed/empty run must never blank the field).
        if (ins.rowCount > 0) {
          await client.query(
            `DELETE FROM contacts_distinct_cache
             WHERE workspace_id = $1 AND field = $2 AND refreshed_at < $3::timestamptz`,
            [workspaceId, field, runTs]
          );
        }
        console.log(`[distinct-cache] refreshed ${field}: ${ins.rowCount} rows in ${Date.now() - t0}ms`);
      }
    } catch (err) {
      console.error('[distinct-cache] refresh failed:', err.message);
    } finally {
      try { await client.query(`SET statement_timeout = 45000`); } catch { /* dead */ }
      client.release();
    }
  }

  // Bucket counts for the # Employees sidebar. Honours every other filter
  // in `filters`, but deliberately drops `numEmployeesRanges` so each
  // bucket shows how many contacts it *would* add if ticked.
  async getEmployeeBucketCounts(workspaceId, filters = {}) {
    const { numEmployeesRanges, ...rest } = filters;
    const { clauses, params } = this._buildFilterClauses(rest);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    // 60s cache — bucket counts don't change second-to-second and re-aggregating
    // 230K rows on every filter change is the dominant cost of filter refreshes.
    const cacheKey = 'emp|' + workspaceId + '|' + where + '|' + params.join('|');
    if (!this._filterCountCache) this._filterCountCache = new Map();
    const now = Date.now();
    const cached = this._filterCountCache.get(cacheKey);
    if (cached && now - cached.ts < 60000) return cached.value;

    const sql = `
      SELECT
        SUM(CASE WHEN num_employees BETWEEN 1     AND 10    THEN 1 ELSE 0 END) AS "1-10",
        SUM(CASE WHEN num_employees BETWEEN 11    AND 20    THEN 1 ELSE 0 END) AS "11-20",
        SUM(CASE WHEN num_employees BETWEEN 21    AND 50    THEN 1 ELSE 0 END) AS "21-50",
        SUM(CASE WHEN num_employees BETWEEN 51    AND 100   THEN 1 ELSE 0 END) AS "51-100",
        SUM(CASE WHEN num_employees BETWEEN 101   AND 200   THEN 1 ELSE 0 END) AS "101-200",
        SUM(CASE WHEN num_employees BETWEEN 201   AND 500   THEN 1 ELSE 0 END) AS "201-500",
        SUM(CASE WHEN num_employees BETWEEN 501   AND 1000  THEN 1 ELSE 0 END) AS "501-1000",
        SUM(CASE WHEN num_employees BETWEEN 1001  AND 2000  THEN 1 ELSE 0 END) AS "1001-2000",
        SUM(CASE WHEN num_employees BETWEEN 2001  AND 5000  THEN 1 ELSE 0 END) AS "2001-5000",
        SUM(CASE WHEN num_employees BETWEEN 5001  AND 10000 THEN 1 ELSE 0 END) AS "5001-10000",
        SUM(CASE WHEN num_employees >= 10001                THEN 1 ELSE 0 END) AS "10001+",
        SUM(CASE WHEN num_employees IS NULL                 THEN 1 ELSE 0 END) AS "unknown"
      FROM contacts WHERE workspace_id = $1${where}
    `;
    const r = await this.query(sql, [workspaceId, ...params]);
    const row = r.rows[0] || {};
    const out = {};
    for (const k of Object.keys(row)) out[k] = parseInt(row[k], 10) || 0;
    this._filterCountCache.set(cacheKey, { value: out, ts: now });
    // Keep cache small — drop expired entries; if still bloated, drop oldest.
    if (this._filterCountCache.size > 500) {
      const cutoff = now - 90000;
      for (const [k, v] of this._filterCountCache) {
        if (v.ts < cutoff) this._filterCountCache.delete(k);
      }
      if (this._filterCountCache.size > 500) {
        const sorted = [...this._filterCountCache].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < sorted.length - 400; i++) {
          this._filterCountCache.delete(sorted[i][0]);
        }
      }
    }
    return out;
  }

  // Re-parse `# Employees` out of raw_data into num_employees. Exposed as
  // a one-click button so the user can rerun it after a deploy that lost
  // the startup run (e.g. due to pool exhaustion).
  async backfillNumEmployees() {
    const r = await this.query(`
      UPDATE contacts
      SET num_employees = CASE
        WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*$'
          THEN regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\D', '', 'g')::int
        WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*-\\s*\\d+\\s*$'
          THEN split_part(regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\s', '', 'g'), '-', 1)::int
        WHEN COALESCE(raw_data->>'# Employees', raw_data->>'Employees') ~ '^\\s*\\d+\\s*\\+\\s*$'
          THEN regexp_replace(COALESCE(raw_data->>'# Employees', raw_data->>'Employees'), '\\D', '', 'g')::int
        ELSE NULL
      END
      WHERE num_employees IS NULL
        AND (raw_data->>'# Employees' IS NOT NULL OR raw_data->>'Employees' IS NOT NULL)
    `);
    return { updated: r.rowCount || 0 };
  }

  // Filter-aware email-provider counts. Same rule as the employee buckets:
  // honour every other filter, but drop `emailProviders` from the input so
  // each row's count reflects "what you'd add by ticking it".
  async getEmailProviderStats(workspaceId, filters = {}) {
    if (!workspaceId) {
      // Backwards-compat: original signature was zero-arg, workspace-wide.
      // Counts on the TRUE MX provider (mx_provider), never Apollo's guess.
      const r = await this.query(`
        SELECT
          COUNT(CASE WHEN mx_provider = 'email_google'  THEN 1 END) as google,
          COUNT(CASE WHEN mx_provider = 'email_outlook' THEN 1 END) as outlook,
          COUNT(CASE WHEN mx_provider = 'email_other'   THEN 1 END) as other,
          COUNT(CASE WHEN mx_provider IS NULL           THEN 1 END) as unknown
        FROM contacts
      `);
      const row = r.rows[0] || {};
      return {
        google:  parseInt(row.google)  || 0,
        outlook: parseInt(row.outlook) || 0,
        other:   parseInt(row.other)   || 0,
        unknown: parseInt(row.unknown) || 0,
      };
    }
    const { emailProviders, ...rest } = filters;
    const { clauses, params } = this._buildFilterClauses(rest);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    // 60s cache shared with employee bucket cache structure
    const cacheKey = 'ep|' + workspaceId + '|' + where + '|' + params.join('|');
    if (!this._filterCountCache) this._filterCountCache = new Map();
    const now = Date.now();
    const cached = this._filterCountCache.get(cacheKey);
    if (cached && now - cached.ts < 60000) return cached.value;

    const sql = `
      SELECT
        COUNT(CASE WHEN mx_provider = 'email_google'  THEN 1 END) as google,
        COUNT(CASE WHEN mx_provider = 'email_outlook' THEN 1 END) as outlook,
        COUNT(CASE WHEN mx_provider = 'email_other'   THEN 1 END) as other,
        COUNT(CASE WHEN mx_provider IS NULL           THEN 1 END) as unknown
      FROM contacts WHERE workspace_id = $1${where}
    `;
    const r = await this.query(sql, [workspaceId, ...params]);
    const row = r.rows[0] || {};
    const value = {
      google:  parseInt(row.google)  || 0,
      outlook: parseInt(row.outlook) || 0,
      other:   parseInt(row.other)   || 0,
      unknown: parseInt(row.unknown) || 0,
    };
    this._filterCountCache.set(cacheKey, { value, ts: now });
    return value;
  }

  // ── True-MX domain cache ─────────────────────────────────────────────
  // MX records belong to the domain, not the mailbox: every address on a
  // domain shares them. So once the verifier resolves one mailbox's MX, we
  // cache it per-domain and fan it out to every contact on that domain —
  // most contacts then never need an individual lookup.

  // Returns the cached true provider for a domain, or null if not yet known.
  async getDomainMxProvider(domain) {
    if (!domain) return null;
    const r = await this.query(
      `SELECT mx_provider FROM domain_mx_cache WHERE domain = $1`,
      [domain.toLowerCase()]
    );
    return r.rows[0]?.mx_provider || null;
  }

  // Record a domain's true provider (newer wins) and fan it out to every
  // contact on that domain. Only ever called with a real verifier MX result —
  // never Apollo's guess, never an unresolved/unknown verdict.
  async setDomainMxProvider(domain, provider) {
    if (!domain || !provider) return { contactsUpdated: 0 };
    const dom = domain.toLowerCase();
    await this.query(
      `INSERT INTO domain_mx_cache (domain, mx_provider, resolved_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (domain) DO UPDATE
         SET mx_provider = EXCLUDED.mx_provider, resolved_at = EXCLUDED.resolved_at`,
      [dom, provider]
    );
    // Newer wins: overwrite every contact on the domain whose value differs.
    const r = await this.query(
      `UPDATE contacts SET mx_provider = $2
         WHERE LOWER(SPLIT_PART(email, '@', 2)) = $1
           AND mx_provider IS DISTINCT FROM $2`,
      [dom, provider]
    );
    return { contactsUpdated: r.rowCount || 0 };
  }

  // One-time recovery: until this fix, the verify path wrote the resolved MX
  // provider into the `tags` array but NOT into the mx_provider column (the
  // column write was missing). So historically-verified contacts have their
  // real provider stuck in tags, and mx_provider is NULL for everyone.
  //
  // We recover it — but ONLY for contacts that were actually verified
  // (email_verified_at IS NOT NULL). A contact's email_* tag has two possible
  // sources: the real verifier (which also stamps email_verified_at) or
  // Apollo's tech-stack guess via backfillEmailProviders (which sets tags
  // only, never email_verified_at). Gating on email_verified_at recovers the
  // trustworthy verifier results and ignores Apollo's untrusted guesses —
  // exactly the distinction we must preserve.
  async recoverMxProviderFromVerifiedTags() {
    // Keyset-paginate by id so each batch SEEKS past the last id instead of
    // re-scanning the whole ~979k-row table for "mx_provider IS NULL" every
    // time (that repeated full scan is what tripped the 45s statement_timeout
    // and aborted the run after 2 batches). Raise the timeout per-statement
    // for the bulk UPDATE, and never let one slow batch kill the whole pass.
    let recovered = 0;
    let lastId = '00000000-0000-0000-0000-000000000000';
    for (let i = 0; i < 1000; i++) {
      let r;
      try {
        r = await this.query(`
          WITH batch AS (
            SELECT id, tags FROM contacts
            WHERE id > $1
              AND email_verified_at IS NOT NULL
              AND mx_provider IS NULL
              AND tags && ARRAY['email_google','email_outlook','email_other']
            ORDER BY id
            LIMIT 5000
          )
          UPDATE contacts c SET mx_provider = CASE
              WHEN 'email_google'  = ANY(b.tags) THEN 'email_google'
              WHEN 'email_outlook' = ANY(b.tags) THEN 'email_outlook'
              WHEN 'email_other'   = ANY(b.tags) THEN 'email_other'
            END
          FROM batch b
          WHERE c.id = b.id
          RETURNING c.id
        `, [lastId], { statementTimeoutMs: 120000 });
      } catch (e) {
        console.warn(`[seed] recovery batch ${i} failed (continuing): ${e.message}`);
        break;
      }
      const n = r.rowCount || 0;
      if (n === 0) break;
      recovered += n;
      // Advance the cursor to the max id in this batch. RETURNING rows are not
      // ordered, so take the explicit max rather than the last row.
      lastId = r.rows.reduce((mx, row) => (row.id > mx ? row.id : mx), lastId);
    }
    return { recovered };
  }

  // One-time seed: build the domain cache from contacts that ALREADY carry a
  // real verifier MX (mx_provider set + email_verified_at present), then fan
  // each domain's provider out to its still-unclassified contacts. Recovers a
  // large chunk of the back-catalogue instantly without trusting Apollo.
  // Keyset-batched by domain so no single statement runs long.
  async seedDomainMxCacheFromVerified() {
    // Clear any prior run's error so the diagnostic reflects THIS run's outcome
    // (else a fixed seed still reports the old failure).
    this._lastSeedError = null;
    // First recover mx_provider from verifier-set tags (the column write was
    // historically missing), so the per-domain seed below has data to read.
    const rec = await this.recoverMxProviderFromVerifiedTags();
    if (rec.recovered) console.log(`[seed] Recovered mx_provider from verified tags for ${rec.recovered} contacts`);

    // Per domain, take the most-recently-verified contact's provider as truth.
    // Use a GROUP BY with a (verified_at, provider) argmax instead of DISTINCT
    // ON: the DISTINCT ON forces a full functional sort of all ~115k matching
    // rows in one statement, which was timing out and aborting the seed
    // (leaving domainsCached=0 even after recovery succeeded). The aggregate
    // form plans as a hash aggregate — far cheaper — and we surface any error
    // instead of letting it abort silently.
    let seedCount = 0;
    try {
      const seed = await this.query(`
        INSERT INTO domain_mx_cache (domain, mx_provider, resolved_at)
        SELECT domain,
               (ARRAY_AGG(mx_provider ORDER BY email_verified_at DESC))[1] AS mx_provider,
               MAX(email_verified_at)                                      AS resolved_at
        FROM (
          SELECT LOWER(SPLIT_PART(email, '@', 2)) AS domain,
                 mx_provider,
                 -- email_verified_at is declared TIMESTAMP but is stored as text
                 -- on the live DB; cast explicitly so MAX()/ORDER BY produce a
                 -- timestamp that matches domain_mx_cache.resolved_at. Without
                 -- this the INSERT throws ("expression is of type text") and the
                 -- whole seed aborts → domainsCached stays 0 and no contacts get
                 -- classified. NULLIF guards empty-string text values.
                 NULLIF(email_verified_at::text, '')::timestamp AS email_verified_at
          FROM contacts
          WHERE mx_provider IN ('email_google','email_outlook','email_other')
            AND email_verified_at IS NOT NULL
            AND email IS NOT NULL AND POSITION('@' IN email) > 0
        ) v
        GROUP BY domain
        ON CONFLICT (domain) DO NOTHING
      `, [], { statementTimeoutMs: 180000 });
      seedCount = seed.rowCount || 0;
    } catch (e) {
      console.warn(`[seed] domain cache INSERT failed: ${e.message}`);
      this._lastSeedError = e.message;
    }
    const seed = { rowCount: seedCount };

    // Fan the seeded providers out to contacts that have no mx_provider yet but
    // whose domain is now known. Batched by id to stay under statement_timeout
    // and avoid a long lock on the ~469k-row contacts table.
    let filled = 0;
    for (let i = 0; i < 200; i++) {
      const r = await this.query(`
        UPDATE contacts c
          SET mx_provider = dmc.mx_provider
        FROM domain_mx_cache dmc
        WHERE c.id IN (
          SELECT c2.id FROM contacts c2
          JOIN domain_mx_cache d2 ON d2.domain = LOWER(SPLIT_PART(c2.email, '@', 2))
          WHERE c2.mx_provider IS NULL AND c2.email IS NOT NULL
          LIMIT 10000
        )
          AND dmc.domain = LOWER(SPLIT_PART(c.email, '@', 2))
      `, [], { statementTimeoutMs: 120000 });
      const n = r.rowCount || 0;
      filled += n;
      if (n === 0) break;
    }
    return { recovered: rec.recovered, domainsSeeded: seed.rowCount || 0, contactsFilled: filled };
  }

  // Live DNS MX lookup for ONE domain → 'email_google' | 'email_outlook' |
  // 'email_other' | null. This is the same method PlusVibe uses on import
  // (resolve the domain's real mail servers; no verification needed) and is
  // ground truth for provider — the actual servers receiving the domain's mail.
  //
  // Accuracy fix vs server.js lookupMxProvider(): a failed/empty resolve
  // returns NULL, NOT 'email_other'. "DNS didn't answer" is unknown, not a real
  // provider — mislabelling it 'Other' would poison Google/Microsoft domains on
  // a transient timeout. NULL lets the next scan retry it.
  async resolveDomainMxProvider(domain) {
    if (!domain) return null;
    let records;
    try {
      records = await mxResolver.resolveMx(domain); // public resolver (1.1.1.1 / 8.8.8.8)
    } catch (e) {
      // ENOTFOUND / ENODATA = domain has no MX (dead/parked) → genuinely 'other'
      // (it exists in our data but routes mail nowhere standard). SERVFAIL /
      // TIMEOUT = transient → NULL so we retry.
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'email_other';
      return null;
    }
    if (!records || !records.length) return 'email_other';
    // Look at ALL MX hosts, not just the top — some setups list the gateway and
    // the real provider together; we want the strongest signal across them.
    const hosts = records
      .sort((a, b) => a.priority - b.priority)
      .map(r => (r.exchange || '').toLowerCase())
      .filter(Boolean);
    const joined = hosts.join(' ');
    if (!joined) return 'email_other';

    // Native Google / Microsoft MX patterns (authoritative — the mail lands here).
    if (/google|gmail|googlemail|aspmx\.l\.google/.test(joined)) return 'email_google';
    if (/protection\.outlook\.com|mail\.protection\.outlook|olc\.protection\.outlook|outlook\.com|office365|hotmail|microsoft/.test(joined)) {
      return 'email_outlook';
    }

    // Gateway in front — Mimecast/Proofpoint/Barracuda/Cisco/Sophos/etc. The MX
    // says the gateway, but the mailbox BEHIND it is usually Google or (more
    // often) Microsoft. MX alone would mislabel these 'Other' and leak real
    // Microsoft past an MS-exclude filter. Unmask via the domain's SPF record,
    // which a tenant almost always still publishes for its true mailbox host.
    if (/mimecast|pphosted|ppe-hosted|proofpoint|barracuda|cisco|iphmx|sophos|messagelabs|symantec|forcepoint|trendmicro|fortimail|mailcontrol|securence|emailsrvr|hornetsecurity|spamtitan|reflexion|spamexperts|antispamcloud|mailanyone|mailprotect|emailfiltering|arsubacloud|clearswift|retarus|libraesva/.test(joined)) {
      const behind = await this._providerFromSpf(domain);
      if (behind) return behind;            // resolved the masked provider
      return 'email_other';                  // unknown behind the gateway
    }

    return 'email_other';
  }

  // Inspect a domain's SPF (TXT) record to infer the true mailbox provider when
  // the MX is a security gateway. Microsoft 365 tenants include
  // 'spf.protection.outlook.com'; Google Workspace includes '_spf.google.com'.
  // Returns 'email_outlook' | 'email_google' | null (couldn't tell).
  async _providerFromSpf(domain, depth = 0) {
    try {
      const txt = await mxResolver.resolveTxt(domain); // public resolver — same automated enrichment path as resolveMx
      const spf = txt.map(parts => parts.join('')).join(' ').toLowerCase();
      // Only inspect the actual SPF record (v=spf1 ...), not arbitrary TXT.
      if (!/v=spf1/.test(spf)) return null;
      // Direct backend signals on this domain's own SPF.
      if (/spf\.protection\.outlook\.com|outlook\.com|sharepointonline|protection\.outlook/.test(spf)) return 'email_outlook';
      if (/_spf\.google\.com|google\.com|googlemail/.test(spf)) return 'email_google';
      // Gateway-fronted tenants often publish only include:spf.<gateway>.com with
      // no direct backend token. Recurse ONE level into the include: chain — the
      // gateway's own SPF frequently reveals the real backend (e.g. a Mimecast
      // include that itself includes spf.protection.outlook.com). Depth-capped at
      // 1 to bound DNS fan-out and avoid include loops.
      if (depth < 1) {
        const includes = [...spf.matchAll(/include:([a-z0-9._-]+)/g)].map(m => m[1]).slice(0, 5);
        for (const inc of includes) {
          // Skip the obvious no-op / self includes.
          if (inc === domain) continue;
          const behind = await this._providerFromSpf(inc, depth + 1);
          if (behind) return behind;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Bulk scanner: live-MX-classify every contact that still has a NULL
  // mx_provider, working one DISTINCT domain at a time (MX is a domain
  // property, so one DNS lookup classifies every contact on it). Idempotent
  // and resumable — re-run to pick up domains that previously timed out
  // (they stay NULL, never get mislabelled).
  //
  // opts: { maxDomains, concurrency, onProgress }
  // Returns { domainsScanned, domainsResolved, domainsFailed, contactsUpdated,
  //           byProvider, exhausted }.
  async scanContactsMxProvider(opts = {}) {
    const maxDomains  = opts.maxDomains  || 100000;
    const concurrency = Math.min(opts.concurrency || 20, 50);
    const BATCH       = 500; // domains pulled from the DB per round

    // Upfront total so the UI can show a real progress bar + ETA. Distinct
    // domains that still need classifying (NULL mx_provider).
    let totalDomains = 0;
    try {
      const tc = await this.query(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT DISTINCT LOWER(SPLIT_PART(email,'@',2)) AS d
          FROM contacts
          WHERE mx_provider IS NULL AND email IS NOT NULL AND POSITION('@' IN email) > 0
        ) q`);
      totalDomains = tc.rows[0]?.n || 0;
    } catch {}

    const stats = {
      totalDomains,
      domainsScanned: 0, domainsResolved: 0, domainsFailed: 0,
      contactsUpdated: 0,
      byProvider: { email_google: 0, email_outlook: 0, email_other: 0 },
      exhausted: false, mode: 'unknowns', startedAt: Date.now(),
    };
    // Domains we've already attempted this run. Failed (transient) domains stay
    // NULL in the DB, so the next SELECT would return them again — without this
    // set the loop would spin forever on a batch that all timed out. We exclude
    // attempted domains from the query so each round makes forward progress;
    // a separate re-run (fresh set) retries the failures later.
    const attempted = new Set();

    while (stats.domainsScanned < maxDomains) {
      // Distinct domains that still have a NULL-provider contact AND haven't
      // been attempted yet this run. setDomainMxProvider fills resolved domains
      // so they drop out naturally; the NOT-IN guard drops failed ones.
      const skip = [...attempted];
      const { rows } = await this.query(`
        SELECT DISTINCT LOWER(SPLIT_PART(email, '@', 2)) AS domain
        FROM contacts
        WHERE mx_provider IS NULL
          AND email IS NOT NULL
          AND POSITION('@' IN email) > 0
          AND ($2::text[] IS NULL OR LOWER(SPLIT_PART(email, '@', 2)) <> ALL($2))
        LIMIT $1
      `, [Math.min(BATCH, maxDomains - stats.domainsScanned), skip.length ? skip : null]);

      if (!rows.length) { stats.exhausted = true; break; }
      rows.forEach(r => r.domain && attempted.add(r.domain));

      // Resolve this batch with bounded DNS concurrency.
      let cursor = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const domain = rows[cursor++]?.domain;
          if (!domain) continue;
          stats.domainsScanned++;
          let provider = null;
          try { provider = await this.resolveDomainMxProvider(domain); }
          catch { provider = null; }
          if (!provider) { stats.domainsFailed++; continue; }
          try {
            const { contactsUpdated } = await this.setDomainMxProvider(domain, provider);
            stats.domainsResolved++;
            stats.contactsUpdated += contactsUpdated;
            stats.byProvider[provider] = (stats.byProvider[provider] || 0) + contactsUpdated;
          } catch (e) {
            stats.domainsFailed++;
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));

      if (opts.onProgress) opts.onProgress({ ...stats });
    }

    return stats;
  }

  // Instant reseed (no DNS): for every contact with a NULL mx_provider whose
  // domain is already resolved in domain_mx_cache, copy that provider across.
  // MX is a domain property, so one cached resolution classifies every contact
  // on the domain. Cheap pre-step before the live scan.
  async reseedMxFromDomainCache() {
    const r = await this.query(`
      UPDATE contacts c
      SET mx_provider = dmc.mx_provider
      FROM domain_mx_cache dmc
      WHERE c.mx_provider IS NULL
        AND dmc.mx_provider IS NOT NULL
        AND LOWER(SPLIT_PART(c.email, '@', 2)) = dmc.domain
    `);
    return { updated: r.rowCount || 0 };
  }

  // Full re-verification: re-resolve MX for EVERY distinct domain we hold (not
  // just NULL ones), so contacts whose provider migrated since the last scan
  // (e.g. Google → Microsoft) get corrected. Heavier than scanContactsMxProvider
  // — use when accuracy matters more than speed. Reuses the same accurate
  // resolver + per-domain fan-out; a transient DNS failure leaves the existing
  // value untouched (never downgraded to a wrong answer).
  async reverifyAllMxProvider(opts = {}) {
    const concurrency = Math.min(opts.concurrency || 20, 50);
    const BATCH = 500;
    // Optional scope: re-resolve ONLY domains currently classified as this
    // provider (e.g. 'email_other') instead of the whole table. Useful for a
    // cheap targeted sweep after a resolver improvement — re-checking the 61k
    // email_other domains to unmask gateway-fronted Microsoft/Google is 3× less
    // DNS work than a full reverify and never touches already-correct rows.
    const onlyProvider = opts.onlyProvider || null;
    // Scope clause is parameterized ($1 when scoped) to avoid any injection.
    const scopeSql = onlyProvider ? ` AND mx_provider = $1` : '';
    // Upfront total (distinct domains in scope) for the progress bar + ETA.
    let totalDomains = 0;
    try {
      const tc = await this.query(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT DISTINCT LOWER(SPLIT_PART(email,'@',2)) AS d
          FROM contacts WHERE email IS NOT NULL AND POSITION('@' IN email) > 0${scopeSql}
        ) q`, onlyProvider ? [onlyProvider] : []);
      totalDomains = tc.rows[0]?.n || 0;
    } catch {}
    const stats = {
      totalDomains,
      domainsScanned: 0, domainsResolved: 0, domainsFailed: 0,
      contactsUpdated: 0, changed: 0,
      byProvider: { email_google: 0, email_outlook: 0, email_other: 0 },
      exhausted: false, mode: 'reverify', startedAt: Date.now(),
    };
    let lastDomain = '';
    while (true) {
      // Keyset-paginate over DISTINCT domains so we cover the whole scope once.
      // When scoped, $1 = provider, $2 = lastDomain, $3 = BATCH; else $1/$2.
      const pageSql = onlyProvider
        ? `SELECT DISTINCT LOWER(SPLIT_PART(email, '@', 2)) AS domain
           FROM contacts
           WHERE email IS NOT NULL AND POSITION('@' IN email) > 0
             AND mx_provider = $1
             AND LOWER(SPLIT_PART(email, '@', 2)) > $2
           ORDER BY domain LIMIT $3`
        : `SELECT DISTINCT LOWER(SPLIT_PART(email, '@', 2)) AS domain
           FROM contacts
           WHERE email IS NOT NULL AND POSITION('@' IN email) > 0
             AND LOWER(SPLIT_PART(email, '@', 2)) > $1
           ORDER BY domain LIMIT $2`;
      const pageParams = onlyProvider ? [onlyProvider, lastDomain, BATCH] : [lastDomain, BATCH];
      const { rows } = await this.query(pageSql, pageParams);
      if (!rows.length) { stats.exhausted = true; break; }
      lastDomain = rows[rows.length - 1].domain;

      let cursor = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const domain = rows[cursor++]?.domain;
          if (!domain) continue;
          stats.domainsScanned++;
          let provider = null;
          try { provider = await this.resolveDomainMxProvider(domain); }
          catch { provider = null; }
          if (!provider) { stats.domainsFailed++; continue; }
          try {
            // Update every contact on this domain whose provider DIFFERS, so we
            // can count real corrections (changed) vs total touched.
            const u = await this.query(
              `UPDATE contacts SET mx_provider = $2
               WHERE LOWER(SPLIT_PART(email, '@', 2)) = $1
                 AND (mx_provider IS DISTINCT FROM $2)`,
              [domain, provider]
            );
            await this.setDomainMxProvider(domain, provider).catch(() => {});
            const n = u.rowCount || 0;
            stats.domainsResolved++;
            stats.contactsUpdated += n;
            stats.changed += n;
            stats.byProvider[provider] = (stats.byProvider[provider] || 0) + n;
          } catch { stats.domainsFailed++; }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (opts.onProgress) opts.onProgress({ ...stats });
    }
    return stats;
  }

  detectEmailProvider(technologiesStr) {
    if (!technologiesStr) return null;
    const tech = technologiesStr.toLowerCase();

    if (tech.includes('google') || tech.includes('gmail') || tech.includes('workspace') || tech.includes('g suite')) {
      return 'email_google';
    }
    if (tech.includes('outlook') || tech.includes('microsoft 365') || tech.includes('exchange') || tech.includes('office 365')) {
      return 'email_outlook';
    }
    if (tech.includes('mail') || tech.includes('email') || tech.includes('smtp')) {
      return 'email_other';
    }
    return null;
  }

  async backfillEmailProviders() {
    // Keyset-paginated maintenance pass. The old single full-table UPDATE
    // scanned all ~469k rows with ILIKE every boot and blew the 45s pool
    // statement_timeout, so it never completed. We now batch by id over only
    // the rows that still need a tag (technologies present, a recognisable
    // provider keyword, and no email_* tag yet). After the first pass this
    // finds almost nothing, so repeat boots are cheap, and it still tags
    // newly-imported contacts going forward. Each query is bounded — no
    // long-running statement, no long lock window.
    const CHUNK = 10000;
    const needsTag = `
      technologies IS NOT NULL AND technologies <> ''
      AND NOT (COALESCE(tags, ARRAY[]::text[]) && ARRAY['email_google','email_outlook','email_other'])
      AND (
        technologies ILIKE '%google workspace%' OR technologies ILIKE '%g suite%' OR technologies ILIKE '%gmail%'
        OR technologies ILIKE '%outlook%' OR technologies ILIKE '%microsoft 365%' OR technologies ILIKE '%exchange%'
        OR LOWER(technologies) LIKE '%smtp%'
      )`;
    const updateSql = `
      UPDATE contacts SET tags = CASE
        WHEN technologies ILIKE '%google workspace%' OR technologies ILIKE '%g suite%' OR technologies ILIKE '%gmail%'
          THEN array_append(array_remove(array_remove(array_remove(COALESCE(tags, ARRAY[]::text[]),'email_google'),'email_outlook'),'email_other'),'email_google')
        WHEN technologies ILIKE '%outlook%' OR technologies ILIKE '%microsoft 365%' OR technologies ILIKE '%exchange%'
          THEN array_append(array_remove(array_remove(array_remove(COALESCE(tags, ARRAY[]::text[]),'email_google'),'email_outlook'),'email_other'),'email_outlook')
        ELSE array_append(array_remove(array_remove(array_remove(COALESCE(tags, ARRAY[]::text[]),'email_google'),'email_outlook'),'email_other'),'email_other')
      END
      WHERE id = ANY($1::uuid[])`;
    let updated = 0;
    let lastId = '00000000-0000-0000-0000-000000000000';
    // Guard against runaway loops: 300 * 10k = 3M-row ceiling.
    for (let i = 0; i < 300; i++) {
      const { rows } = await this.query(
        `SELECT id FROM contacts WHERE id > $1 AND ${needsTag} ORDER BY id LIMIT $2`,
        [lastId, CHUNK]
      );
      if (!rows.length) break;
      const ids = rows.map(r => r.id);
      lastId = ids[ids.length - 1];
      const res = await this.query(updateSql, [ids]);
      updated += res.rowCount || 0;
    }
    return { processed: updated, updated };
  }

  async deleteAllContacts() {
    const sql = 'DELETE FROM contacts;';
    const result = await this.query(sql, []);
    return { deleted: result.rowCount || 0 };
  }

  // Delete contacts whose email or apollo_id matches any in the given lists.
  // dryRun=true returns the would-delete count without modifying anything.
  // Used by the "delete-from-csv" flow when re-scraping stale Apollo data.
  async deleteByCsvKeys({ emails = [], apolloIds = [], dryRun = false }) {
    const cleanEmails = [...new Set(emails.map(e => (e || '').toString().trim().toLowerCase()).filter(Boolean))];
    const cleanApolloIds = [...new Set(apolloIds.map(a => (a || '').toString().trim()).filter(Boolean))];
    if (!cleanEmails.length && !cleanApolloIds.length) return { deleted: 0, matched: 0 };

    const countSql = `
      SELECT COUNT(*)::int AS n FROM contacts
      WHERE ($1::text[] IS NOT NULL AND LOWER(email) = ANY($1::text[]))
         OR ($2::text[] IS NOT NULL AND apollo_id = ANY($2::text[]))
    `;
    const { rows } = await this.query(countSql, [cleanEmails, cleanApolloIds]);
    const matched = rows[0]?.n || 0;
    if (dryRun || matched === 0) return { deleted: 0, matched };

    const delSql = `
      DELETE FROM contacts
      WHERE ($1::text[] IS NOT NULL AND LOWER(email) = ANY($1::text[]))
         OR ($2::text[] IS NOT NULL AND apollo_id = ANY($2::text[]))
    `;
    const result = await this.query(delSql, [cleanEmails, cleanApolloIds]);
    return { deleted: result.rowCount || 0, matched };
  }

  // Append a {workspace_id, campaign_id, campaign_name, pushed_at} entry
  // to each contact's pushed_campaigns JSONB array. Used after a successful
  // PlusVibe push so future verify-and-push runs against the same campaign
  // can skip them. JSONB || jsonb_build_object is a single statement so
  // we batch via UNNEST + a join to keep the lock window tiny.
  // Heal company_name + job_title_cleaned for the rows that produced a
  // different value when re-cleaned at push time. Idempotent — no-op if the
  // stored value already matches.
  async bulkUpdateCleanedNames(updates) {
    if (!Array.isArray(updates) || !updates.length) return { updated: 0 };
    // Batch into a single UPDATE per row via UNNEST so we don't issue 100 round-trips.
    const ids = updates.map(u => u.id);
    const companies = updates.map(u => u.company_name);
    const titles = updates.map(u => u.job_title_cleaned);
    const sql = `
      UPDATE contacts AS c
      SET company_name      = COALESCE(NULLIF(u.company_name, ''), c.company_name),
          job_title_cleaned = COALESCE(NULLIF(u.job_title_cleaned, ''), c.job_title_cleaned),
          updated_at        = CURRENT_TIMESTAMP
      FROM (
        SELECT UNNEST($1::uuid[]) AS id,
               UNNEST($2::text[]) AS company_name,
               UNNEST($3::text[]) AS job_title_cleaned
      ) AS u
      WHERE c.id = u.id
        AND (c.company_name IS DISTINCT FROM COALESCE(NULLIF(u.company_name, ''), c.company_name)
          OR c.job_title_cleaned IS DISTINCT FROM COALESCE(NULLIF(u.job_title_cleaned, ''), c.job_title_cleaned))
    `;
    const r = await this.query(sql, [ids, companies, titles]);
    if (r.rowCount > 0) console.log(`[clean-on-push] healed ${r.rowCount} company/title rows`);
    return { updated: r.rowCount || 0 };
  }

  // ── Audience Scoring ──────────────────────────────────────────────────────
  // Builds a responder profile for a workspace (who replied / became a lead)
  // then scores every unsent contact against it. Scores 0-100 based on how
  // many of 5 dimensions (seniority, department, industry, country, company
  // size) match the top values seen among actual responders.
  //
  // Two data sources for responders, merged with UNION DISTINCT:
  //   1. email_events (recent webhook data — most accurate, has workspace_id)
  //   2. pushed_campaigns + positive status (older data — workspace known from push stamp)
  async computeAudienceScores(workspaceId) {
    const sql = `
      WITH

      -- ── Responders: contacts with a positive outcome for this workspace ──
      ws_responders AS (
        -- Path 1: webhook events (accurate workspace attribution)
        SELECT DISTINCT LOWER(ee.lead_email) AS email_lc
        FROM email_events ee
        WHERE ee.workspace_id = $1
          AND ee.event_type IN ('reply', 'lead')

        UNION

        -- Path 2: pushed to this workspace AND had a positive status outcome
        -- (covers pre-webhook history; imprecise only if a contact had
        --  multiple workspaces — acceptable for profiling)
        SELECT DISTINCT LOWER(c.email) AS email_lc
        FROM contacts c
        WHERE (c.status = 'interested' OR c.marked_as_lead_at IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(c.pushed_campaigns,'[]'::jsonb)) pc
            WHERE pc->>'workspace_id' = $1
          )
      ),

      responder_contacts AS (
        SELECT
          c.seniority,
          c.department,
          c.industry,
          COALESCE(NULLIF(LOWER(c.company_country),''), NULLIF(LOWER(c.country),'')) AS country,
          CASE
            WHEN c.num_employees IS NULL     THEN NULL
            WHEN c.num_employees <= 10       THEN '1-10'
            WHEN c.num_employees <= 50       THEN '11-50'
            WHEN c.num_employees <= 200      THEN '51-200'
            WHEN c.num_employees <= 500      THEN '201-500'
            WHEN c.num_employees <= 1000     THEN '501-1000'
            ELSE '1000+'
          END AS emp_bucket
        FROM contacts c
        WHERE LOWER(c.email) IN (SELECT email_lc FROM ws_responders)
      ),

      responder_count AS (SELECT COUNT(*) AS n FROM responder_contacts),

      -- Top values per dimension (use top 3-5 so the model isn't too narrow)
      top_seniority AS (
        SELECT LOWER(seniority) AS val FROM responder_contacts
        WHERE seniority IS NOT NULL AND seniority <> ''
        GROUP BY LOWER(seniority) ORDER BY COUNT(*) DESC LIMIT 3
      ),
      top_department AS (
        SELECT LOWER(department) AS val FROM responder_contacts
        WHERE department IS NOT NULL AND department <> ''
        GROUP BY LOWER(department) ORDER BY COUNT(*) DESC LIMIT 3
      ),
      top_industry AS (
        SELECT LOWER(industry) AS val FROM responder_contacts
        WHERE industry IS NOT NULL AND industry <> ''
        GROUP BY LOWER(industry) ORDER BY COUNT(*) DESC LIMIT 5
      ),
      top_country AS (
        SELECT country AS val FROM responder_contacts
        WHERE country IS NOT NULL AND country <> ''
        GROUP BY country ORDER BY COUNT(*) DESC LIMIT 5
      ),
      top_emp AS (
        SELECT emp_bucket AS val FROM responder_contacts
        WHERE emp_bucket IS NOT NULL
        GROUP BY emp_bucket ORDER BY COUNT(*) DESC LIMIT 2
      ),

      -- ── Unsent contacts: never pushed to this workspace ───────────────
      unsent AS (
        SELECT
          c.id,
          c.seniority,
          c.department,
          c.industry,
          COALESCE(NULLIF(LOWER(c.company_country),''), NULLIF(LOWER(c.country),'')) AS country,
          CASE
            WHEN c.num_employees IS NULL     THEN NULL
            WHEN c.num_employees <= 10       THEN '1-10'
            WHEN c.num_employees <= 50       THEN '11-50'
            WHEN c.num_employees <= 200      THEN '51-200'
            WHEN c.num_employees <= 500      THEN '201-500'
            WHEN c.num_employees <= 1000     THEN '501-1000'
            ELSE '1000+'
          END AS emp_bucket
        FROM contacts c
        WHERE c.do_not_contact IS NOT TRUE
          AND c.email_status IN ('safe', 'safe_catchall')
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(c.pushed_campaigns,'[]'::jsonb)) pc
            WHERE pc->>'workspace_id' = $1
          )
      ),

      -- ── Score each unsent contact ─────────────────────────────────────
      -- 5 dimensions, 20 points each = 100 max.
      -- A dimension scores 0 if the contact has no value for it (NULL/empty).
      scored AS (
        SELECT
          u.id AS contact_id,
          (
            CASE WHEN LOWER(COALESCE(u.seniority,''))  IN (SELECT val FROM top_seniority)  THEN 20 ELSE 0 END +
            CASE WHEN LOWER(COALESCE(u.department,'')) IN (SELECT val FROM top_department) THEN 20 ELSE 0 END +
            CASE WHEN LOWER(COALESCE(u.industry,''))   IN (SELECT val FROM top_industry)   THEN 20 ELSE 0 END +
            CASE WHEN u.country                        IN (SELECT val FROM top_country)    THEN 20 ELSE 0 END +
            CASE WHEN u.emp_bucket                     IN (SELECT val FROM top_emp)        THEN 20 ELSE 0 END
          ) AS score,
          jsonb_build_object(
            'seniority_match',  LOWER(COALESCE(u.seniority,''))  IN (SELECT val FROM top_seniority),
            'department_match', LOWER(COALESCE(u.department,'')) IN (SELECT val FROM top_department),
            'industry_match',   LOWER(COALESCE(u.industry,''))   IN (SELECT val FROM top_industry),
            'country_match',    u.country                        IN (SELECT val FROM top_country),
            'emp_match',        u.emp_bucket                     IN (SELECT val FROM top_emp)
          ) AS breakdown
        FROM unsent u
      )

      -- ── Upsert scores ─────────────────────────────────────────────────
      INSERT INTO audience_scores (workspace_id, contact_id, score, breakdown, computed_at)
      SELECT $1, contact_id, score, breakdown, CURRENT_TIMESTAMP
      FROM scored
      ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
        score       = EXCLUDED.score,
        breakdown   = EXCLUDED.breakdown,
        computed_at = CURRENT_TIMESTAMP

      RETURNING (SELECT n FROM responder_count) AS responder_count
    `;

    const r = await this.query(sql, [workspaceId]);
    const responderCount = r.rows[0]?.responder_count ?? 0;

    // Persist the profile summary (top values) for display in the UI
    const profileSql = `
      WITH ws_responders AS (
        SELECT DISTINCT LOWER(ee.lead_email) AS email_lc
        FROM email_events ee
        WHERE ee.workspace_id = $1 AND ee.event_type IN ('reply', 'lead')
        UNION
        SELECT DISTINCT LOWER(c.email) AS email_lc
        FROM contacts c
        WHERE (c.status = 'interested' OR c.marked_as_lead_at IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(c.pushed_campaigns,'[]'::jsonb)) pc
            WHERE pc->>'workspace_id' = $1
          )
      ),
      rc AS (
        SELECT c.seniority, c.department, c.industry,
          COALESCE(NULLIF(LOWER(c.company_country),''), NULLIF(LOWER(c.country),'')) AS country,
          CASE
            WHEN c.num_employees IS NULL THEN NULL
            WHEN c.num_employees <= 10   THEN '1-10'
            WHEN c.num_employees <= 50   THEN '11-50'
            WHEN c.num_employees <= 200  THEN '51-200'
            WHEN c.num_employees <= 500  THEN '201-500'
            WHEN c.num_employees <= 1000 THEN '501-1000'
            ELSE '1000+'
          END AS emp_bucket
        FROM contacts c
        WHERE LOWER(c.email) IN (SELECT email_lc FROM ws_responders)
      ),
      sent_count AS (
        SELECT COUNT(*) AS n FROM contacts c
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(c.pushed_campaigns,'[]'::jsonb)) pc
          WHERE pc->>'workspace_id' = $1
        )
      )
      SELECT jsonb_build_object(
        'top_seniorities',  (SELECT jsonb_agg(val ORDER BY cnt DESC) FROM (SELECT LOWER(seniority) AS val, COUNT(*) AS cnt FROM rc WHERE seniority IS NOT NULL AND seniority <> '' GROUP BY LOWER(seniority) ORDER BY cnt DESC LIMIT 5) s),
        'top_departments',  (SELECT jsonb_agg(val ORDER BY cnt DESC) FROM (SELECT LOWER(department) AS val, COUNT(*) AS cnt FROM rc WHERE department IS NOT NULL AND department <> '' GROUP BY LOWER(department) ORDER BY cnt DESC LIMIT 5) s),
        'top_industries',   (SELECT jsonb_agg(val ORDER BY cnt DESC) FROM (SELECT LOWER(industry) AS val, COUNT(*) AS cnt FROM rc WHERE industry IS NOT NULL AND industry <> '' GROUP BY LOWER(industry) ORDER BY cnt DESC LIMIT 8) s),
        'top_countries',    (SELECT jsonb_agg(val ORDER BY cnt DESC) FROM (SELECT country AS val, COUNT(*) AS cnt FROM rc WHERE country IS NOT NULL AND country <> '' GROUP BY country ORDER BY cnt DESC LIMIT 8) s),
        'top_emp_buckets',  (SELECT jsonb_agg(val ORDER BY cnt DESC) FROM (SELECT emp_bucket AS val, COUNT(*) AS cnt FROM rc WHERE emp_bucket IS NOT NULL GROUP BY emp_bucket ORDER BY cnt DESC LIMIT 5) s)
      ) AS profile,
      (SELECT COUNT(*) FROM rc) AS responder_count,
      (SELECT n FROM sent_count) AS sent_count
    `;

    const pr = await this.query(profileSql, [workspaceId]);
    const { profile, responder_count: rc, sent_count: sc } = pr.rows[0] || {};

    await this.query(`
      INSERT INTO client_audience_profiles (workspace_id, responder_count, sent_count, profile, computed_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id) DO UPDATE SET
        responder_count = EXCLUDED.responder_count,
        sent_count      = EXCLUDED.sent_count,
        profile         = EXCLUDED.profile,
        computed_at     = CURRENT_TIMESTAMP
    `, [workspaceId, rc || 0, sc || 0, JSON.stringify(profile || {})]);

    return { scored: r.rowCount || 0, responders: Number(rc || 0), sent: Number(sc || 0) };
  }

  // Fetch top-N recommended contacts for a workspace (pre-scored, unsent)
  async getRecommendedBatch(workspaceId, limit = 500, minScore = 0) {
    const sql = `
      SELECT
        c.id, c.email, c.first_name, c.last_name,
        c.job_title, c.company_name, c.industry,
        c.seniority, c.department, c.country, c.company_country,
        c.num_employees, c.email_status,
        s.score, s.breakdown, s.computed_at AS scored_at
      FROM audience_scores s
      JOIN contacts c ON c.id = s.contact_id
      WHERE s.workspace_id = $1
        AND s.score >= $2
        AND c.do_not_contact IS NOT TRUE
        AND c.email_status IN ('safe', 'safe_catchall')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(c.pushed_campaigns,'[]'::jsonb)) pc
          WHERE pc->>'workspace_id' = $1
        )
      ORDER BY s.score DESC, c.id
      LIMIT $3
    `;
    const r = await this.query(sql, [workspaceId, minScore, limit]);
    return r.rows;
  }

  async stampPushedCampaign(contactIds, workspaceId, campaignId, campaignName) {
    if (!contactIds || !contactIds.length) return { stamped: 0 };
    const entry = JSON.stringify({
      workspace_id: workspaceId,
      campaign_id:  campaignId,
      campaign_name: campaignName || '',
      pushed_at: new Date().toISOString().slice(0, 10),
    });
    const today = new Date().toISOString().slice(0, 10);
    // pushed_at is the honest field — this stamp records a PUSH, not a send.
    // 'last_sent' is kept in step with it because the 60-day cooldown (here,
    // in _buildFilterClauses, and in the four server.js push filters) still
    // reads that key; dropping it would silently disable every cooldown.
    // Only the webhook 'sent' handler sets `count`, so count===0 with a
    // pushed_at present means "handed to PlusVibe, no send confirmed yet".
    const sql = `
      UPDATE contacts
      SET pushed_campaigns = COALESCE(pushed_campaigns, '[]'::jsonb) || $1::jsonb,
          emailed_workspaces = jsonb_set(
            COALESCE(emailed_workspaces, '{}'::jsonb),
            ARRAY[$2],
            COALESCE(emailed_workspaces->$2, '{}'::jsonb)
              || jsonb_build_object('last_sent', $3::text, 'pushed_at', $3::text),
            true
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($4::uuid[])
    `;
    const result = await this.query(sql, [`[${entry}]`, workspaceId, today, contactIds]);
    return { stamped: result.rowCount || 0 };
  }

  async upsertDomainHealth(row) {
    const sql = `
      INSERT INTO domain_health
        (domain, workspace_id, workspace_name, spf, dkim, dmarc, mx, blacklists, score, status, last_checked, notes, redirect, updated_at)
      VALUES
        ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, NOW(), $11, $12::jsonb, NOW())
      ON CONFLICT (domain) DO UPDATE SET
        workspace_id   = COALESCE(EXCLUDED.workspace_id, domain_health.workspace_id),
        workspace_name = COALESCE(EXCLUDED.workspace_name, domain_health.workspace_name),
        spf            = EXCLUDED.spf,
        dkim           = EXCLUDED.dkim,
        dmarc          = EXCLUDED.dmarc,
        mx             = EXCLUDED.mx,
        blacklists     = EXCLUDED.blacklists,
        score          = EXCLUDED.score,
        status         = EXCLUDED.status,
        last_checked   = NOW(),
        notes          = EXCLUDED.notes,
        redirect       = EXCLUDED.redirect,
        updated_at     = NOW()
    `;
    await this.query(sql, [
      row.domain,
      row.workspace_id || null,
      row.workspace_name || null,
      JSON.stringify(row.spf || {}),
      JSON.stringify(row.dkim || {}),
      JSON.stringify(row.dmarc || {}),
      JSON.stringify(row.mx || {}),
      JSON.stringify(row.blacklists || []),
      row.score || 0,
      row.status || 'unknown',
      row.notes || null,
      JSON.stringify(row.redirect || {}),
    ]);
  }

  async listDomainHealth(opts = {}) {
    // By default hide ignored rows so the dashboard reflects active
    // sending infrastructure only. Pass { includeIgnored: true } to
    // show the full set (e.g. for a future "Show archived" toggle).
    const where = opts.includeIgnored ? '' : 'WHERE ignored_at IS NULL';
    const r = await this.query(
      `SELECT * FROM domain_health ${where} ORDER BY status DESC, score ASC, domain ASC`
    );
    return r.rows;
  }

  // Update ONLY the redirect column for a domain (safe manual refresh). Does
  // not touch SPF/DKIM/DMARC/MX/blacklist/score — those stay as last measured.
  // Also backfills the domain→client (workspace) assignment from the live PV
  // roster when known, so the Domains page shows which client owns each domain.
  // Upserts a bare row if the domain isn't present yet.
  async updateDomainRedirect(domain, redirect, ws) {
    await this.query(
      `INSERT INTO domain_health (domain, redirect, workspace_id, workspace_name, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, NOW())
       ON CONFLICT (domain) DO UPDATE SET
         redirect       = EXCLUDED.redirect,
         workspace_id   = COALESCE(EXCLUDED.workspace_id,   domain_health.workspace_id),
         workspace_name = COALESCE(EXCLUDED.workspace_name, domain_health.workspace_name),
         updated_at     = NOW()`,
      [domain, JSON.stringify(redirect || {}), ws?.id || null, ws?.name || null]
    );
  }

  // Set (or clear, with null) the expected redirect target for a domain.
  async setExpectedRedirect(domain, expected) {
    const r = await this.query(
      `UPDATE domain_health SET expected_redirect = $2, updated_at = NOW() WHERE domain = $1`,
      [domain, expected || null]
    );
    return { changed: r.rowCount || 0 };
  }

  async setDomainIgnored(domain, ignored) {
    const sql = `UPDATE domain_health SET ignored_at = ${ignored ? 'NOW()' : 'NULL'}, updated_at = NOW() WHERE domain = $1`;
    const r = await this.query(sql, [domain]);
    return { changed: r.rowCount || 0 };
  }

  async isDomainIgnored(domain) {
    const r = await this.query(`SELECT ignored_at FROM domain_health WHERE domain = $1`, [domain]);
    return !!(r.rows[0] && r.rows[0].ignored_at);
  }

  async listIgnoredDomains() {
    const r = await this.query(`SELECT domain FROM domain_health WHERE ignored_at IS NOT NULL`);
    return r.rows.map(x => x.domain);
  }

  // ── Google Postmaster Tools data ────────────────────────────────────

  async upsertPostmasterData(domain, date, fields) {
    const sql = `
      INSERT INTO postmaster_data
        (domain, date, domain_reputation, ip_reputation, spam_rate,
         spf_pass_rate, dkim_pass_rate, dmarc_pass_rate, ip_reputations, raw_data, fetched_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, NOW())
      ON CONFLICT (domain, date) DO UPDATE SET
        domain_reputation = EXCLUDED.domain_reputation,
        ip_reputation     = EXCLUDED.ip_reputation,
        spam_rate         = EXCLUDED.spam_rate,
        spf_pass_rate     = EXCLUDED.spf_pass_rate,
        dkim_pass_rate    = EXCLUDED.dkim_pass_rate,
        dmarc_pass_rate   = EXCLUDED.dmarc_pass_rate,
        ip_reputations    = EXCLUDED.ip_reputations,
        raw_data          = EXCLUDED.raw_data,
        fetched_at        = NOW()
    `;
    await this.query(sql, [
      domain,
      date,
      fields.domain_reputation || null,
      fields.ip_reputation || null,
      fields.spam_rate ?? null,
      fields.spf_pass_rate ?? null,
      fields.dkim_pass_rate ?? null,
      fields.dmarc_pass_rate ?? null,
      JSON.stringify(fields.ip_reputations || []),
      JSON.stringify(fields.raw_data || {}),
    ]);
  }

  async listPostmasterLatest() {
    // Latest row per domain, joined with domain_health for workspace info.
    const r = await this.query(`
      SELECT DISTINCT ON (p.domain)
        p.domain, p.date, p.domain_reputation, p.ip_reputation,
        p.spam_rate, p.spf_pass_rate, p.dkim_pass_rate, p.dmarc_pass_rate,
        p.ip_reputations, p.fetched_at,
        dh.workspace_id, dh.workspace_name
      FROM postmaster_data p
      LEFT JOIN domain_health dh ON p.domain = dh.domain AND dh.ignored_at IS NULL
      ORDER BY p.domain, p.date DESC
    `);
    return r.rows;
  }

  async listPostmasterHistory(domain, days = 30) {
    const r = await this.query(
      `SELECT * FROM postmaster_data WHERE domain = $1 ORDER BY date DESC LIMIT $2`,
      [domain, days]
    );
    return r.rows;
  }

  // Upsert pm_* tracking fields on a domain_health row (creates row if missing).
  async setDomainPostmasterTracking(domain, fields) {
    const sql = `
      INSERT INTO domain_health (domain, pm_txt_token, pm_txt_added_at, pm_verified_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (domain) DO UPDATE SET
        pm_txt_token    = CASE WHEN $2 IS NOT NULL THEN $2 ELSE domain_health.pm_txt_token END,
        pm_txt_added_at = CASE WHEN $3 IS NOT NULL THEN $3 ELSE domain_health.pm_txt_added_at END,
        pm_verified_at  = CASE WHEN $4 IS NOT NULL THEN $4 ELSE domain_health.pm_verified_at END,
        updated_at      = NOW()
    `;
    await this.query(sql, [
      domain,
      fields.pm_txt_token ?? null,
      fields.pm_txt_added_at ?? null,
      fields.pm_verified_at ?? null,
    ]);
  }

  async listDomainPostmasterTracking() {
    const r = await this.query(`
      SELECT domain, pm_txt_token, pm_txt_added_at, pm_verified_at
      FROM domain_health
      WHERE pm_txt_token IS NOT NULL OR pm_verified_at IS NOT NULL
    `);
    return r.rows;
  }

  // ── Payslips ────────────────────────────────────────────────────────
  async upsertPayslip(managerName, month, filename, mimetype, dataBase64) {
    await this.query(`
      INSERT INTO payslips (manager_name, month, filename, mimetype, data)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (manager_name, month) DO UPDATE SET
        filename = EXCLUDED.filename, mimetype = EXCLUDED.mimetype,
        data = EXCLUDED.data, uploaded_at = NOW()
    `, [managerName, month, filename, mimetype, dataBase64]);
  }
  async getPayslip(managerName, month) {
    const r = await this.query(
      `SELECT id, manager_name, month, filename, mimetype, data, uploaded_at FROM payslips WHERE manager_name=$1 AND month=$2`,
      [managerName, month]
    );
    return r.rows[0] || null;
  }
  async listPayslips(managerName) {
    const r = await this.query(
      `SELECT id, manager_name, month, filename, mimetype, uploaded_at FROM payslips WHERE manager_name=$1 ORDER BY month DESC`,
      [managerName]
    );
    return r.rows;
  }
  async listAllPayslips() {
    const r = await this.query(`SELECT id, manager_name, month, filename, mimetype, uploaded_at FROM payslips ORDER BY month DESC, manager_name`);
    return r.rows;
  }
  async deletePayslip(id) {
    await this.query(`DELETE FROM payslips WHERE id=$1`, [id]);
  }

  // ── App settings ────────────────────────────────────────────────────
  async getSetting(key, defaultValue = {}) {
    const r = await this.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return r.rows.length ? r.rows[0].value : defaultValue;
  }

  async setSetting(key, value) {
    await this.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()
    `, [key, JSON.stringify(value)]);
  }

  // ── Mailbox metadata (supplier + type tagging) ─────────────────────
  async listMailboxMeta() {
    const r = await this.query(`SELECT * FROM mailbox_meta`);
    return r.rows;
  }

  async upsertMailboxMeta(email, fields) {
    const e = (email || '').toLowerCase();
    const supplier     = fields.supplier ?? null;
    const mailbox_type = fields.mailbox_type ?? null;
    const notes        = fields.notes ?? null;
    const sql = `
      INSERT INTO mailbox_meta (email, supplier, mailbox_type, notes, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (email) DO UPDATE SET
        supplier     = COALESCE(EXCLUDED.supplier,     mailbox_meta.supplier),
        mailbox_type = COALESCE(EXCLUDED.mailbox_type, mailbox_meta.mailbox_type),
        notes        = COALESCE(EXCLUDED.notes,        mailbox_meta.notes),
        updated_at   = NOW()
      RETURNING *;
    `;
    const r = await this.query(sql, [e, supplier, mailbox_type, notes]);
    return r.rows[0];
  }

  // Bulk-fill auto-detected provider type for mailboxes that have no type yet.
  // Only writes where mailbox_type IS NULL so manual overrides set on the
  // Mailboxes page are never clobbered. rows: [{ email, mailbox_type }].
  // Used by the mailbox cache refresh so SQL consumers (combo analysis) can
  // classify senders without depending on someone manually tagging each box.
  async backfillMailboxTypes(rows) {
    const clean = (rows || [])
      .map(r => ({ email: (r.email || '').toLowerCase(), mailbox_type: r.mailbox_type }))
      .filter(r => r.email.includes('@') && r.mailbox_type);
    if (!clean.length) return 0;
    const values = [];
    const params = [];
    clean.forEach((r, i) => {
      values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
      params.push(r.email, r.mailbox_type);
    });
    const sql = `
      INSERT INTO mailbox_meta (email, mailbox_type)
      VALUES ${values.join(',')}
      ON CONFLICT (email) DO UPDATE SET
        mailbox_type = EXCLUDED.mailbox_type,
        updated_at   = NOW()
      WHERE mailbox_meta.mailbox_type IS NULL
    `;
    const r = await this.query(sql, params);
    return r.rowCount || 0;
  }

  // ── Mailbox pricing ────────────────────────────────────────────────
  async listMailboxPricing() {
    const r = await this.query(`SELECT * FROM mailbox_pricing ORDER BY supplier, mailbox_type`);
    return r.rows;
  }

  async upsertMailboxPricing(supplier, mailbox_type, unit_cost, notes) {
    const sql = `
      INSERT INTO mailbox_pricing (supplier, mailbox_type, unit_cost, notes, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (supplier, mailbox_type) DO UPDATE SET
        unit_cost  = EXCLUDED.unit_cost,
        notes      = COALESCE(EXCLUDED.notes, mailbox_pricing.notes),
        updated_at = NOW()
      RETURNING *;
    `;
    const r = await this.query(sql, [supplier, mailbox_type, unit_cost, notes || null]);
    return r.rows[0];
  }

  // ── Monthly operating expenses ─────────────────────────────────────
  async listMonthlyExpenses() {
    const r = await this.query(`SELECT * FROM monthly_expenses ORDER BY start_month DESC, label`);
    return r.rows;
  }

  async createMonthlyExpense({ label, category, amount, currency, start_month, end_month, notes }) {
    const sql = `
      INSERT INTO monthly_expenses (label, category, amount, currency, start_month, end_month, notes)
      VALUES ($1, $2, $3, COALESCE($4, 'USD'), $5, $6, $7)
      RETURNING *;
    `;
    const r = await this.query(sql, [label, category || null, amount, currency || null, start_month, end_month || null, notes || null]);
    return r.rows[0];
  }

  async updateMonthlyExpense(id, fields) {
    const r = await this.query(
      `UPDATE monthly_expenses SET
         label       = COALESCE($2, label),
         category    = COALESCE($3, category),
         amount      = COALESCE($4, amount),
         currency    = COALESCE($5, currency),
         start_month = COALESCE($6, start_month),
         end_month   = $7,
         notes       = COALESCE($8, notes),
         updated_at  = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, fields.label || null, fields.category || null, fields.amount || null,
       fields.currency || null, fields.start_month || null, fields.end_month || null, fields.notes || null]
    );
    return r.rows[0];
  }

  async deleteMonthlyExpense(id) {
    await this.query(`DELETE FROM monthly_expenses WHERE id = $1`, [id]);
    return { ok: true };
  }

  // ── Campaign filter snapshots ─────────────────────────────────
  async saveCampaignFilter({ workspace_id, workspace_name, campaign_id, campaign_name, filters }) {
    if (!workspace_id || !campaign_id) throw new Error('workspace_id and campaign_id required');
    await this.query(`
      INSERT INTO campaign_filters (workspace_id, workspace_name, campaign_id, campaign_name, filters, saved_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, campaign_id) DO UPDATE SET
        workspace_name = EXCLUDED.workspace_name,
        campaign_name  = EXCLUDED.campaign_name,
        filters        = EXCLUDED.filters,
        saved_at       = CURRENT_TIMESTAMP
    `, [workspace_id, workspace_name || null, campaign_id, campaign_name || null, JSON.stringify(filters || {})]);
    return { ok: true };
  }

  async listCampaignFilters() {
    const r = await this.query(`
      SELECT workspace_id, workspace_name, campaign_id, campaign_name, filters, saved_at
      FROM campaign_filters
      ORDER BY workspace_name NULLS LAST, campaign_name NULLS LAST
    `);
    return r.rows;
  }

  async deleteCampaignFilter(workspace_id, campaign_id) {
    await this.query(
      `DELETE FROM campaign_filters WHERE workspace_id = $1 AND campaign_id = $2`,
      [workspace_id, campaign_id]
    );
    return { ok: true };
  }

  // Bulk supplier/type assignment — used by the "select 50 → tag all as Maildoso" flow.
  async bulkSetMailboxField(emails, field, value) {
    if (!Array.isArray(emails) || !emails.length) return { changed: 0 };
    const allowed = ['supplier', 'mailbox_type', 'billing_start_date', 'billing_day'];
    if (!allowed.includes(field)) throw new Error('Invalid field');
    const sql = `
      INSERT INTO mailbox_meta (email, ${field}, updated_at)
      SELECT LOWER(e), $1, NOW() FROM UNNEST($2::text[]) AS e
      ON CONFLICT (email) DO UPDATE SET
        ${field}   = EXCLUDED.${field},
        updated_at = NOW()
    `;
    const r = await this.query(sql, [value, emails]);
    return { changed: r.rowCount || 0 };
  }

  // Bulk set billing date + day for a group of mailboxes (e.g. all Winnr mailboxes
  // purchased on the same date). Used by the bulk billing form in mailboxes.html.
  async bulkSetBilling(emails, billing_start_date, billing_day) {
    if (!Array.isArray(emails) || !emails.length) return { changed: 0 };
    const sql = `
      INSERT INTO mailbox_meta (email, billing_start_date, billing_day, updated_at)
      SELECT LOWER(e), $1::date, $2::int, NOW() FROM UNNEST($3::text[]) AS e
      ON CONFLICT (email) DO UPDATE SET
        billing_start_date = EXCLUDED.billing_start_date,
        billing_day        = EXCLUDED.billing_day,
        updated_at         = NOW()
    `;
    const r = await this.query(sql, [billing_start_date, billing_day, emails]);
    return { changed: r.rowCount || 0 };
  }

  // Per-row billing import: rows = [{email, billing_start_date}]
  async bulkSetBillingRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return { changed: 0 };
    const emails = rows.map(r => r.email.toLowerCase().trim());
    const dates  = rows.map(r => r.billing_start_date);
    const days   = rows.map(r => new Date(r.billing_start_date).getUTCDate());
    const sql = `
      INSERT INTO mailbox_meta (email, billing_start_date, billing_day, updated_at)
      SELECT LOWER(e), d::date, dy::int, NOW()
      FROM UNNEST($1::text[], $2::text[], $3::int[]) AS t(e, d, dy)
      ON CONFLICT (email) DO UPDATE SET
        billing_start_date = EXCLUDED.billing_start_date,
        billing_day        = EXCLUDED.billing_day,
        updated_at         = NOW()
    `;
    const r = await this.query(sql, [emails, dates, days]);
    return { changed: r.rowCount || 0 };
  }

  async stampExportedToApollo(workspaceId, ids) {
    if (!ids || ids.length === 0) return { stamped: 0 };
    // Use ANY($2::uuid[]) to avoid hitting PostgreSQL's parameter limit
    // (~65k positional params per statement; we may have tens of thousands of ids).
    const sql = `
      UPDATE contacts
      SET exported_to_apollo_at = NOW()
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
        AND exported_to_apollo_at IS NULL
    `;
    // Stamping up to 100k rows updates every index on the table — that UPDATE was
    // the query blowing the 45s pool timeout AFTER the CSV was already built (the
    // SELECT is ~2s). Run it on a raised-timeout client like the export SELECTs.
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = '300000'`);
      const result = await client.query(sql, [workspaceId, ids]);
      return { stamped: result.rowCount || 0 };
    } finally {
      try { await client.query(`SET statement_timeout = 45000`); } catch { /* connection may be dead */ }
      client.release();
    }
  }

  // Performance cache persistence — survive restarts without re-fetching PlusVibe
  async loadPerfCacheDaily() {
    const r = await this.query(`SELECT ws_id, date, data, saved_at FROM perf_cache_daily`);
    return r.rows; // [{ ws_id, date, data, saved_at }]
  }

  async savePerfCacheDaily(entries) {
    // entries: [{ wsId, date, data, savedAt }]
    if (!entries.length) return;
    const vals = entries.map((e, i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
    const params = entries.flatMap(e => [e.wsId, e.date, JSON.stringify(e.data), e.savedAt]);
    await this.query(`
      INSERT INTO perf_cache_daily (ws_id, date, data, saved_at)
      VALUES ${vals}
      ON CONFLICT (ws_id, date) DO UPDATE SET data=EXCLUDED.data, saved_at=EXCLUDED.saved_at
    `, params);
  }

  async loadPerfCacheLeads() {
    const r = await this.query(`SELECT ws_id, data, saved_at FROM perf_cache_leads`);
    return r.rows;
  }

  async savePerfCacheLeads(entries) {
    if (!entries.length) return;
    const vals = entries.map((e, i) => `($${i*3+1},$${i*3+2},$${i*3+3})`).join(',');
    const params = entries.flatMap(e => [e.wsId, JSON.stringify(e.data), e.savedAt]);
    await this.query(`
      INSERT INTO perf_cache_leads (ws_id, data, saved_at)
      VALUES ${vals}
      ON CONFLICT (ws_id) DO UPDATE SET data=EXCLUDED.data, saved_at=EXCLUDED.saved_at
    `, params);
  }

  async clearPerfCache() {
    await this.query(`TRUNCATE perf_cache_daily, perf_cache_leads`);
  }

  async loadProviderMix() {
    const r = await this.query(`SELECT ws_id, data, saved_at FROM provider_mix_cache`);
    return r.rows; // [{ ws_id, data, saved_at }]
  }

  async saveProviderMix(wsId, data, savedAt) {
    await this.query(`
      INSERT INTO provider_mix_cache (ws_id, data, saved_at)
      VALUES ($1,$2,$3)
      ON CONFLICT (ws_id) DO UPDATE SET data=EXCLUDED.data, saved_at=EXCLUDED.saved_at
    `, [wsId, JSON.stringify(data), savedAt]);
  }

  // ── Revenue leads ──────────────────────────────────────────────────
  // Bulk upsert all leads from the current PlusVibe sync so they survive
  // workspace deletion.
  async upsertRevenueLeads(leads) {
    const valid = (leads || []).filter(l => l.lead_key);
    if (!valid.length) return 0;
    const sql = `
      INSERT INTO revenue_leads
        (lead_key, workspace_id, workspace_name, client_name, lead_email,
         first_name, last_name, campaign, lead_price, date, label, pv_nonlead, updated_at)
      SELECT
        unnest($1::text[]),  unnest($2::text[]),    unnest($3::text[]),    unnest($4::text[]),
        unnest($5::text[]),  unnest($6::text[]),    unnest($7::text[]),    unnest($8::text[]),
        unnest($9::numeric[]), unnest($10::text[]), unnest($11::text[]),
        unnest($12::boolean[]), NOW()
      ON CONFLICT (lead_key) DO UPDATE SET
        workspace_name = EXCLUDED.workspace_name,
        client_name    = EXCLUDED.client_name,
        lead_email     = EXCLUDED.lead_email,
        first_name     = EXCLUDED.first_name,
        last_name      = EXCLUDED.last_name,
        campaign       = EXCLUDED.campaign,
        lead_price     = EXCLUDED.lead_price,
        date           = EXCLUDED.date,
        label          = EXCLUDED.label,
        pv_nonlead     = EXCLUDED.pv_nonlead,
        updated_at     = NOW()
    `;
    const r = await this.query(sql, [
      valid.map(l => l.lead_key),
      valid.map(l => l.workspace_id    || ''),
      valid.map(l => l.workspace_name  || l.client_name || ''),
      valid.map(l => l.client_name     || ''),
      valid.map(l => l.lead_email      || ''),
      valid.map(l => l.first_name      || ''),
      valid.map(l => l.last_name       || ''),
      valid.map(l => l.campaign        || ''),
      valid.map(l => l.lead_price      || 0),
      valid.map(l => l.date            || ''),
      valid.map(l => l.label           || ''),
      valid.map(l => Boolean(l.pv_nonlead)),
    ]);
    return r.rowCount || 0;
  }

  // Return persisted leads whose workspace_id is not in the current live set.
  async getDeletedWorkspaceLeads(liveWsIds) {
    const live = [...(liveWsIds || [])].filter(Boolean);
    const r = live.length
      ? await this.query(`SELECT * FROM revenue_leads WHERE workspace_id != ALL($1::text[])`, [live])
      : await this.query(`SELECT * FROM revenue_leads`);
    return r.rows;
  }

  // ── Manual revenue entries ─────────────────────────────────────────
  async listManualRevenueEntries(month) {
    const r = month
      ? await this.query(`SELECT * FROM revenue_manual_entries WHERE month = $1 ORDER BY created_at`, [month])
      : await this.query(`SELECT * FROM revenue_manual_entries ORDER BY month DESC, created_at`);
    return r.rows;
  }

  async createManualRevenueEntry({ workspace_id, month, lead_count, price_per_lead, note }) {
    const r = await this.query(
      `INSERT INTO revenue_manual_entries (workspace_id, month, lead_count, price_per_lead, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workspace_id, month, lead_count, price_per_lead, note || null]
    );
    return r.rows[0];
  }

  async deleteManualRevenueEntry(id) {
    const r = await this.query(
      `DELETE FROM revenue_manual_entries WHERE id = $1 RETURNING id`,
      [id]
    );
    return r.rowCount > 0;
  }
}

module.exports = PostgresDatabase;
