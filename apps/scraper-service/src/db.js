import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

// Self-migrating, like the legacy db-postgres.js. Safe to run on every boot.
export async function ensureSchema() {
  await pool.query(`
    -- One row per domain we've scraped. Linked back to ch_companies when known.
    CREATE TABLE IF NOT EXISTS scraped_contacts (
      domain         TEXT PRIMARY KEY,
      company_number TEXT,
      page_url       TEXT,
      emails         TEXT[] NOT NULL DEFAULT '{}',
      phones         TEXT[] NOT NULL DEFAULT '{}',
      raw_names      TEXT[] NOT NULL DEFAULT '{}',
      status         TEXT NOT NULL DEFAULT 'ok',   -- ok | no_contact | error | discovery_failed
      error_msg      TEXT,
      scraped_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_scraped_company ON scraped_contacts(company_number);
    CREATE INDEX IF NOT EXISTS idx_scraped_at ON scraped_contacts(scraped_at);

    -- A batch of work, created by the dashboard (filter+queue, selected, or run-all).
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id          SERIAL PRIMARY KEY,
      label       TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
      total       INTEGER NOT NULL DEFAULT 0,
      done        INTEGER NOT NULL DEFAULT 0,
      ok          INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at  TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status);

    -- One target per job. domain may be null until discovery runs.
    CREATE TABLE IF NOT EXISTS scrape_job_items (
      id             SERIAL PRIMARY KEY,
      job_id         INTEGER NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
      company_number TEXT,
      company_name   TEXT,
      domain         TEXT,
      status         TEXT NOT NULL DEFAULT 'pending', -- pending | done | error
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_job_items_job ON scrape_job_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_items_status ON scrape_job_items(job_id, status);

    -- Enrichment columns (added incrementally; safe on existing installs).
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS website       TEXT;
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS address       TEXT;
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS business_type TEXT;
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS industry      TEXT;
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS keywords      TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS description   TEXT;
    ALTER TABLE scraped_contacts ADD COLUMN IF NOT EXISTS socials       JSONB;

    ALTER TABLE scrape_jobs       ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ch';
    ALTER TABLE scrape_jobs       ADD COLUMN IF NOT EXISTS fields TEXT[];
    ALTER TABLE scrape_job_items  ADD COLUMN IF NOT EXISTS location TEXT;
  `)
}

// Claim the oldest queued job atomically so two workers never grab the same one.
export async function claimNextJob() {
  const { rows } = await pool.query(`
    UPDATE scrape_jobs
       SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM scrape_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *
  `)
  return rows[0] ?? null
}

export async function loadPendingItems(jobId, limit) {
  const { rows } = await pool.query(
    `SELECT id, company_number, company_name, domain, location
       FROM scrape_job_items
      WHERE job_id = $1 AND status = 'pending'
      ORDER BY id
      LIMIT $2`,
    [jobId, limit]
  )
  return rows
}

// Given a list of domains, return the set already present in scraped_contacts —
// so the worker can skip re-crawling anything we already have (dedup / save cost).
export async function existingScrapedDomains(domains) {
  const list = [...new Set((domains || []).filter(Boolean))]
  if (!list.length) return new Set()
  const { rows } = await pool.query(
    `SELECT domain FROM scraped_contacts WHERE domain = ANY($1::text[])`,
    [list]
  )
  return new Set(rows.map(r => r.domain))
}

// CH context for fallback values + classifier hints (null for list-source items).
export async function getCompanyContext(companyNumber) {
  if (!companyNumber) return null
  const { rows } = await pool.query(
    `SELECT company_name, company_type, sic_codes, industry,
            address_line1, address_line2, post_town, county, postcode
       FROM ch_companies WHERE company_number = $1`,
    [companyNumber]
  )
  if (!rows[0]) return null
  const r = rows[0]
  const address = [r.address_line1, r.address_line2, r.post_town, r.county, r.postcode]
    .filter(Boolean)
    .join(', ')
  return {
    company_type: r.company_type || null,
    sic_codes: r.sic_codes || null,
    industry: r.industry || null,
    address: address || null,
  }
}

export async function saveContact(c) {
  await pool.query(
    `INSERT INTO scraped_contacts
       (domain, company_number, page_url, website, emails, phones, raw_names,
        address, business_type, industry, keywords, description, socials,
        status, error_msg, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (domain) DO UPDATE SET
       company_number = COALESCE(EXCLUDED.company_number, scraped_contacts.company_number),
       page_url      = EXCLUDED.page_url,
       website       = EXCLUDED.website,
       emails        = EXCLUDED.emails,
       phones        = EXCLUDED.phones,
       raw_names     = EXCLUDED.raw_names,
       address       = COALESCE(EXCLUDED.address, scraped_contacts.address),
       business_type = COALESCE(EXCLUDED.business_type, scraped_contacts.business_type),
       industry      = COALESCE(EXCLUDED.industry, scraped_contacts.industry),
       keywords      = EXCLUDED.keywords,
       description   = COALESCE(EXCLUDED.description, scraped_contacts.description),
       socials       = EXCLUDED.socials,
       status        = EXCLUDED.status,
       error_msg     = EXCLUDED.error_msg,
       scraped_at    = now()`,
    [
      c.domain, c.company_number ?? null, c.pageUrl ?? null, c.website ?? (c.domain ? `https://${c.domain}` : null),
      c.emails ?? [], c.phones ?? [], c.names ?? [],
      c.address ?? null, c.business_type ?? null, c.industry ?? null,
      c.keywords ?? [], c.description ?? null, c.socials ? JSON.stringify(c.socials) : null,
      c.status, c.errorMsg ?? null,
    ]
  )
}

// Persist a domain we discovered back onto the company record.
export async function writeBackDomain(companyNumber, domain) {
  if (!companyNumber || !domain) return
  await pool.query(
    `UPDATE ch_companies
        SET website = COALESCE(NULLIF(website, ''), $2),
            domain_checked_at = now()
      WHERE company_number = $1`,
    [companyNumber, domain]
  )
}

export async function markItem(itemId, status, domain) {
  await pool.query(
    `UPDATE scrape_job_items SET status = $2, domain = COALESCE($3, domain) WHERE id = $1`,
    [itemId, status, domain ?? null]
  )
}

export async function bumpJob(jobId, { okDelta = 0, failedDelta = 0, doneDelta = 0 }) {
  await pool.query(
    `UPDATE scrape_jobs
        SET done = done + $2, ok = ok + $3, failed = failed + $4
      WHERE id = $1`,
    [jobId, doneDelta, okDelta, failedDelta]
  )
}

// Don't overwrite a job the dashboard cancelled — only finalise queued/running.
export async function finishJob(jobId, error) {
  await pool.query(
    `UPDATE scrape_jobs
        SET status = $2, finished_at = now(), error = $3
      WHERE id = $1 AND status IN ('queued','running')`,
    [jobId, error ? 'failed' : 'done', error ?? null]
  )
}

// Lightweight status check so the worker can stop a cancelled job mid-run.
export async function getJobStatus(jobId) {
  const { rows } = await pool.query(`SELECT status FROM scrape_jobs WHERE id = $1`, [jobId])
  return rows[0]?.status ?? null
}
