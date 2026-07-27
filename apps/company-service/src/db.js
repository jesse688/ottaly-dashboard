import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 20, // engine runs many concurrent local queries
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

// Run an ALTER COLUMN ... TYPE only if the column isn't already the target type.
// A bare ALTER TYPE takes an ACCESS EXCLUSIVE lock and rewrites the table on EVERY
// boot even when it's a no-op — which hangs startup if another session holds a lock.
// The information_schema check is a cheap read (no lock), so steady-state boots skip
// the ALTER entirely. targetType: the data_type as information_schema reports it
// (e.g. 'text', or 'ARRAY' for TEXT[]). Missing table/column → skip quietly.
async function migrateColumnType(table, column, targetType, alterSql) {
  try {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    )
    if (!rows.length) return                       // column doesn't exist yet — nothing to migrate
    if (rows[0].data_type === targetType) return   // already the target type — skip the locking ALTER
    await pool.query(alterSql)
  } catch (e) { console.warn(`[schema] migrateColumnType ${table}.${column}:`, e.message) }
}

// Self-migrating, like scraper-service/src/db.js and admin-legacy's db-postgres.
// Safe to run on every boot. Owns the `companies` table (keyed by domain) and the
// refresh queue; adds provenance columns to the shared `contacts` table.
export async function ensureSchema() {
  await pool.query(`
    -- One row per DOMAIN. The resolved CH identity + ownership verdicts live here
    -- once, then get stamped onto every contact sharing the domain.
    CREATE TABLE IF NOT EXISTS companies (
      domain               TEXT PRIMARY KEY,
      -- resolved CH identity
      ch_company_number    TEXT,
      ch_company_name      TEXT,
      ch_company_status    TEXT,     -- active | not active
      ch_company_type      TEXT,
      ch_postcode          TEXT,     -- registered-office postcode (feeds CCOD)
      ch_address           TEXT,
      ch_sic_codes         TEXT,
      ch_date_of_cessation TEXT,
      -- match provenance
      match_method         TEXT,     -- officer | psc | name_postcode | none
      match_confidence     TEXT,     -- confident | medium | low | none
      anchor_contact_id    TEXT,     -- contact whose name matched an officer/PSC (contacts.id is a UUID)
      anchor_officer_name  TEXT,     -- the CH officer/PSC name that matched
      -- full CH payloads for audit + re-derivation
      officers_snapshot    JSONB,
      psc_snapshot         JSONB,
      -- ownership verdicts (both fall out of the ONE resolve)
      business_owner       TEXT,     -- yes | no | unknown
      business_owner_basis TEXT,     -- contact_is_psc | contact_not_psc | psc_known_not_matched | no_psc_filed | no_psc_data
      psc_owners           TEXT[],   -- the company's identified >25% owners (from PSC)
      building_owner       TEXT,     -- yes | no | unclear | no_postcode
      building_owner_name  TEXT,
      building_site_count  INT,
      -- refresh bookkeeping
      senior_contact_ids   TEXT[],   -- contacts.id is a UUID
      last_refreshed_at    TIMESTAMPTZ,
      refresh_error        TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_companies_stale    ON companies(last_refreshed_at NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_companies_chnumber ON companies(ch_company_number);

    -- Continuous-refresh queue (mirrors scrape_jobs). One row per domain to (re)resolve.
    CREATE TABLE IF NOT EXISTS company_refresh_jobs (
      id          SERIAL PRIMARY KEY,
      domain      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
      priority    INT  NOT NULL DEFAULT 0,          -- staleness score (higher = older)
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at  TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_crj_claim ON company_refresh_jobs(status, priority DESC, created_at);

    -- Provenance stamped onto contacts (kept minimal; the ch_* columns already exist).
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_data_provenance TEXT; -- anchor | inherited | unresolved
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_stamped_at TIMESTAMPTZ;
    -- Authoritative CH-derived ownership stamped from the engine (distinct from the
    -- older reply/manual owns_building signal). ccod_owns_building / ccod_building_owner
    -- already exist (the first CCOD sweep). Add business ownership (PSC) here.
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_owner TEXT;      -- yes | no | unknown
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_owner_basis TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS psc_owners TEXT[];        -- the company's >25% owners

    -- Persons with Significant Control, loaded from the CH free PSC bulk snapshot
    -- (download.companieshouse.gov.uk/en_pscdata.html) via scripts/import-psc-bulk.js.
    -- Lets the resolver read ownership locally instead of an API call per company.
    -- One row per (company, PSC). kind distinguishes individual vs corporate owner.
    CREATE TABLE IF NOT EXISTS ch_psc (
      company_number TEXT NOT NULL,
      name           TEXT,
      kind           TEXT,      -- individual-person… | corporate-entity… | legal-person… | *-statement
      ceased_on      TEXT,      -- non-null = this PSC no longer in control
      natures        TEXT[],    -- natures_of_control (encodes the >25% thresholds)
      created_at     TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ch_psc_company ON ch_psc(company_number);
    -- Marks whether the PSC bulk has been loaded + freshness (import script updates it).
    CREATE TABLE IF NOT EXISTS ch_psc_meta (
      id INT PRIMARY KEY DEFAULT 1,
      loaded_at   TIMESTAMPTZ,
      snapshot    TEXT,     -- the snapshot date/label imported
      row_count   BIGINT
    );

    -- HM Land Registry CCOD ("UK companies that own property in England & Wales"),
    -- postcode-keyed. Lets the resolver answer "does this company own its building?"
    -- locally (no volume / no SQLite file needed). Loaded via scripts/ccod-*.mjs.
    CREATE TABLE IF NOT EXISTS ch_ccod (
      postcode            TEXT NOT NULL,   -- normalised (no spaces, upper)
      title_number        TEXT,
      tenure              TEXT,            -- Freehold | Leasehold
      property_address    TEXT,
      proprietor_name     TEXT,
      company_reg_no      TEXT,
      proprietor_category TEXT,
      created_at          TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ch_ccod_postcode ON ch_ccod(postcode);
    CREATE TABLE IF NOT EXISTS ch_ccod_meta (
      id INT PRIMARY KEY DEFAULT 1,
      loaded_at TIMESTAMPTZ, snapshot TEXT, row_count BIGINT
    );
  `)
  // contacts.id is a UUID, not a bigint. If an earlier boot created companies with
  // BIGINT id columns, migrate them to TEXT. Guard on the CURRENT type: a bare
  // ALTER COLUMN ... TYPE takes an ACCESS EXCLUSIVE lock and rewrites the table EVERY
  // boot even when already TEXT — which blocks the whole startup (→ crash-loop/502)
  // if any other session holds a lock on `companies`. Only fire the ALTER when the
  // column isn't already the target type.
  await migrateColumnType('companies', 'anchor_contact_id', 'text',
    `ALTER TABLE companies ALTER COLUMN anchor_contact_id TYPE TEXT USING anchor_contact_id::text`)
  await migrateColumnType('companies', 'senior_contact_ids', 'ARRAY',
    `ALTER TABLE companies ALTER COLUMN senior_contact_ids TYPE TEXT[] USING senior_contact_ids::text[]`)
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS psc_owners TEXT[]`)
  // Officer cache marker on the shared ch_directors table: rows the company-service
  // fetched itself (complete + fresh), safe to trust vs admin-legacy's partial rows.
  await pool.query(`ALTER TABLE ch_directors ADD COLUMN IF NOT EXISTS fetched_by_svc_at TIMESTAMPTZ`).catch(() => {})
  // Expression index backing localSearch's normalised (alphanumeric-only) name
  // match on ch_companies — without it, the regexp_replace LIKE is a 5M-row scan.
  // Built in the background; localSearch tolerates its brief absence (falls to API).
  pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ch_companies_normname
       ON ch_companies (regexp_replace(replace(lower(company_name),'&','and'),'[^a-z0-9]','','g') text_pattern_ops)`
  ).catch((e) => console.warn('[schema] normname index:', e.message))
  // Index the join key EVERYTHING here uses: getDomainContacts, stampContacts, and
  // the /stamp-all batch UPDATE all filter contacts by company_domain. Without it
  // each of those is a full sequential scan of contacts — the /stamp-all batches
  // were doing a whole-table scan PER 2000-domain batch (~80s each, IO-bound). With
  // it, each batch is an index range scan (ms). CONCURRENTLY so building it doesn't
  // lock out admin-legacy's live reads/writes on contacts; fire-and-forget (can't
  // run inside a txn), and the stamp tolerates its brief absence.
  pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_company_domain ON contacts (company_domain)`)
    .catch((e) => console.warn('[schema] contacts company_domain index:', e.message))
}

// Senior decision-makers for a domain, most senior first. seniority is a free-text
// column ("C-Suite", "Founder", "Owner", "Director", "VP", "Head", …) so we rank by
// a coarse tier rather than assume a fixed vocabulary.
const SENIOR_RANK = `
  CASE
    WHEN LOWER(COALESCE(seniority,'')) ~ '(c.?suite|chief|founder|owner|partner|principal|proprietor|ceo|cfo|coo|cto|managing director|director)' THEN 3
    WHEN LOWER(COALESCE(seniority,'')) ~ '(vp|vice president|head|lead|manager)' THEN 2
    WHEN COALESCE(seniority,'') <> '' THEN 1
    ELSE 0
  END`

export async function getDomainContacts(domain, limit = 8) {
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, seniority, company_name, company_address
       FROM contacts
      WHERE company_domain = $1
        AND (first_name IS NOT NULL OR last_name IS NOT NULL)
      ORDER BY ${SENIOR_RANK} DESC, id
      LIMIT $2`,
    [domain, limit]
  )
  return rows
}

// Any contact on the domain, for company_name/address fallback when there's no
// named senior contact.
export async function getDomainMeta(domain) {
  const { rows } = await pool.query(
    `SELECT company_name, company_address
       FROM contacts
      WHERE company_domain = $1
        AND (company_name IS NOT NULL AND company_name <> '')
      ORDER BY (company_address IS NOT NULL) DESC, id
      LIMIT 1`,
    [domain]
  )
  return rows[0] || null
}

// Upsert the resolved company row.
export async function saveCompany(c) {
  await pool.query(
    `INSERT INTO companies (
       domain, ch_company_number, ch_company_name, ch_company_status, ch_company_type,
       ch_postcode, ch_address, ch_sic_codes, ch_date_of_cessation,
       match_method, match_confidence, anchor_contact_id, anchor_officer_name,
       officers_snapshot, psc_snapshot,
       business_owner, business_owner_basis, psc_owners, building_owner, building_owner_name, building_site_count,
       senior_contact_ids, last_refreshed_at, refresh_error
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,now(),$23
     )
     ON CONFLICT (domain) DO UPDATE SET
       ch_company_number=EXCLUDED.ch_company_number, ch_company_name=EXCLUDED.ch_company_name,
       ch_company_status=EXCLUDED.ch_company_status, ch_company_type=EXCLUDED.ch_company_type,
       ch_postcode=EXCLUDED.ch_postcode, ch_address=EXCLUDED.ch_address,
       ch_sic_codes=EXCLUDED.ch_sic_codes, ch_date_of_cessation=EXCLUDED.ch_date_of_cessation,
       match_method=EXCLUDED.match_method, match_confidence=EXCLUDED.match_confidence,
       anchor_contact_id=EXCLUDED.anchor_contact_id, anchor_officer_name=EXCLUDED.anchor_officer_name,
       officers_snapshot=EXCLUDED.officers_snapshot, psc_snapshot=EXCLUDED.psc_snapshot,
       business_owner=EXCLUDED.business_owner, business_owner_basis=EXCLUDED.business_owner_basis,
       psc_owners=EXCLUDED.psc_owners,
       building_owner=EXCLUDED.building_owner, building_owner_name=EXCLUDED.building_owner_name,
       building_site_count=EXCLUDED.building_site_count,
       senior_contact_ids=EXCLUDED.senior_contact_ids, last_refreshed_at=now(),
       refresh_error=EXCLUDED.refresh_error`,
    [
      c.domain, c.ch_company_number ?? null, c.ch_company_name ?? null, c.ch_company_status ?? null,
      c.ch_company_type ?? null, c.ch_postcode ?? null, c.ch_address ?? null, c.ch_sic_codes ?? null,
      c.ch_date_of_cessation ?? null, c.match_method ?? 'none', c.match_confidence ?? 'none',
      c.anchor_contact_id ?? null, c.anchor_officer_name ?? null,
      c.officers_snapshot ? JSON.stringify(c.officers_snapshot) : null,
      c.psc_snapshot ? JSON.stringify(c.psc_snapshot) : null,
      c.business_owner ?? 'unknown', c.business_owner_basis ?? null, c.psc_owners ?? null,
      c.building_owner ?? null, c.building_owner_name ?? null, c.building_site_count ?? null,
      c.senior_contact_ids ?? null, c.refresh_error ?? null,
    ]
  )
}

// Stamp the resolved company down onto every contact on the domain (compatibility
// with admin-legacy, which reads contacts.ch_*). Shadow mode skips this entirely.
export async function stampContacts(c) {
  await pool.query(
    `UPDATE contacts SET
       ch_company_number = $2,
       ch_match_confidence = $3,
       ch_postcode = COALESCE($4, ch_postcode),
       ch_verified_at = now(),
       ccod_owns_building = $6,          -- building ownership (owns | no | unclear | no_postcode)
       ccod_building_owner = $7,         -- the registered proprietor at the postcode
       business_owner = $8,              -- business ownership (yes | no | unknown, from PSC)
       business_owner_basis = $9,
       psc_owners = $10,                 -- the company's >25% owners
       company_data_provenance = CASE WHEN id::text = $5 THEN 'anchor'
                                      WHEN $2 IS NULL THEN 'unresolved'
                                      ELSE 'inherited' END,
       company_stamped_at = now()
     WHERE company_domain = $1`,
    [c.domain, c.ch_company_number ?? null, c.match_confidence ?? 'none', c.ch_postcode ?? null,
     c.anchor_contact_id ?? null, c.building_owner ?? null, c.building_owner_name ?? null,
     c.business_owner ?? null, c.business_owner_basis ?? null, c.psc_owners ?? null]
  )
}

export async function getCompany(domain) {
  const { rows } = await pool.query(`SELECT * FROM companies WHERE domain = $1`, [domain])
  return rows[0] || null
}

// ── Continuous-refresh queue ───────────────────────────────────────────────

// Top up the queue with domains not already queued/running, prioritised by
// staleness (never-resolved first, then oldest last_refreshed_at). Returns how
// many were enqueued. Bounded by `limit` so we never enqueue the whole DB at once.
export async function enqueueStaleDomains(limit = 500) {
  // priority = staleness in seconds, capped to INT range. Never-resolved domains
  // get the max (2147483647) so they sort first. (Was overflowing INT with bigint.)
  const STALENESS = `LEAST(COALESCE(EXTRACT(EPOCH FROM (now() - co.last_refreshed_at))::bigint, 2147483647), 2147483647)`
  const { rows } = await pool.query(
    `INSERT INTO company_refresh_jobs (domain, priority)
     SELECT d.domain, ${STALENESS}
       FROM (SELECT DISTINCT company_domain AS domain FROM contacts
              WHERE company_domain IS NOT NULL AND company_domain <> ''
                AND company_name IS NOT NULL AND company_name <> '') d
       LEFT JOIN companies co ON co.domain = d.domain
      WHERE NOT EXISTS (
              SELECT 1 FROM company_refresh_jobs j
               WHERE j.domain = d.domain AND j.status IN ('queued','running'))
      ORDER BY ${STALENESS} DESC
      LIMIT $1
     RETURNING id`,
    [limit])
  return rows.length
}

// Atomically claim the highest-priority queued job (SKIP LOCKED so parallel
// workers never grab the same one). Mirrors scraper-service claimNextJob.
export async function claimNextRefreshJob() {
  const { rows } = await pool.query(
    `UPDATE company_refresh_jobs
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM company_refresh_jobs
         WHERE status = 'queued'
         ORDER BY priority DESC, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
     RETURNING id, domain`)
  return rows[0] || null
}

export async function finishRefreshJob(id, error) {
  await pool.query(
    `UPDATE company_refresh_jobs
        SET status = $2, finished_at = now(), error = $3
      WHERE id = $1`,
    [id, error ? 'failed' : 'done', error || null])
}

// Recover jobs a crash left 'running' back to 'queued' on boot.
export async function requeueRunning() {
  const { rowCount } = await pool.query(
    `UPDATE company_refresh_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`)
  return rowCount
}

export async function queueDepth() {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM company_refresh_jobs GROUP BY status`)
  const out = { queued: 0, running: 0, done: 0, failed: 0 }
  for (const r of rows) out[r.status] = r.n
  return out
}
