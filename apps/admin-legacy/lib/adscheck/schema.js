// Google Ads Transparency checker — table definitions.
//
// Lives in the existing admin-legacy Postgres (prefixed `ads_*` rather than a
// separate `adscheck` database) so the checker shares the pool and deploys with
// the rest of the dashboard. Everything is IF NOT EXISTS, so init() is safe to
// run on every boot.
//
// Batch ids are app-generated UUIDs (crypto.randomUUID) rather than
// gen_random_uuid() — no pgcrypto extension required on the target instance.

const DDL = `
CREATE TABLE IF NOT EXISTS ads_batches (
  id          uuid PRIMARY KEY,
  name        text,
  region      text NOT NULL DEFAULT 'anywhere',
  total       int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'running'   -- running | paused | done
);

CREATE TABLE IF NOT EXISTS ads_jobs (
  id          bigserial PRIMARY KEY,
  batch_id    uuid NOT NULL REFERENCES ads_batches(id) ON DELETE CASCADE,
  domain      text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',   -- queued | running | done | error
  attempts    int  NOT NULL DEFAULT 0,
  locked_at   timestamptz,                      -- refreshed by the owning worker's heartbeat
  locked_by   text,
  runs_ads    boolean,
  ad_count    int,
  is_estimate boolean,
  advertisers jsonb,
  error       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_jobs_claim   ON ads_jobs (status, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_ads_jobs_batch   ON ads_jobs (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_ads_jobs_stale   ON ads_jobs (locked_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_ads_jobs_updated ON ads_jobs (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_jobs_batch_domain ON ads_jobs (batch_id, domain);

-- Cross-batch result cache so the same domain isn't re-scraped within the TTL.
-- Keyed on (domain, region): a domain can run ads in GB but not US.
CREATE TABLE IF NOT EXISTS ads_domain_cache (
  domain      text NOT NULL,
  region      text NOT NULL DEFAULT 'anywhere',
  runs_ads    boolean,
  ad_count    int,
  is_estimate boolean,
  advertisers jsonb,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, region)
);

-- Which CONTACTS a batch came from. The queue works in domains (many contacts
-- share one company domain), but a PlusVibe push needs contact ids — and
-- /api/contacts/verify-and-push takes contact_ids. This link table is what lets
-- "filter the results, push the winners" resolve back to real contacts.
CREATE TABLE IF NOT EXISTS ads_batch_contacts (
  batch_id   uuid NOT NULL REFERENCES ads_batches(id) ON DELETE CASCADE,
  -- TEXT, not bigint: contacts.id is a UUID (db-schema-postgres.sql). The first
  -- cut assumed bigint and Number(uuid) -> NaN silently rejected every contact,
  -- so the whole Contacts handoff failed with "no valid domains found". TEXT
  -- also keeps this working if the id type ever changes again.
  contact_id text NOT NULL,
  domain     text NOT NULL,
  PRIMARY KEY (batch_id, contact_id)
);
-- Repair the bigint version shipped briefly before the UUID id was noticed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='ads_batch_contacts' AND column_name='contact_id'
                AND data_type <> 'text') THEN
    ALTER TABLE ads_batch_contacts ALTER COLUMN contact_id TYPE text USING contact_id::text;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ads_batch_contacts_domain ON ads_batch_contacts (batch_id, domain);

-- Worker liveness. Each replica upserts its own row; /api/ads/health reads it so
-- "is anything actually draining the queue?" is answerable without shell access.
CREATE TABLE IF NOT EXISTS ads_workers (
  id             text PRIMARY KEY,
  in_flight      int  NOT NULL DEFAULT 0,
  concurrency    int  NOT NULL DEFAULT 0,
  browser_ok     boolean,
  note           text,
  last_heartbeat timestamptz NOT NULL DEFAULT now()
);
`;

// Normalises contacts.company_domain to the form ads_jobs.domain is stored in:
// lowercased, scheme stripped, leading www. stripped, path/query dropped.
// Apollo exports carry all of "kingspan.com", "www.Kingspan.com" and
// "https://egg.com" for the same company — a www-only strip silently misses the
// scheme-prefixed rows, which then never get stamped and never show up in the
// Contacts filter. MUST stay character-identical to idx_contacts_domain_norm in
// db-postgres.js, or Postgres won't use the index and every stamp seq-scans.
const DOMAIN_NORM_SQL =
  `REGEXP_REPLACE(LOWER(COALESCE(company_domain,'')), '^(https?://)?(www\\.)?([^/?#]+).*$', '\\3')`;

// The per-contact projection of the ads results. These live on `contacts`, so
// they're ALTERs on a ~600k-row table under constant load — and the main
// migration runner in db-postgres.js uses lock_timeout=5s and SILENTLY swallows
// lock-timeout failures, so on a busy deploy they simply never get added and the
// Contacts filter then 500s on a missing column. Owned here instead, with a
// longer lock_timeout and retries, and reported by /api/ads/diag.
const CONTACT_COLUMNS = [
  ['ads_runs_ads', 'BOOLEAN'],
  ['ads_count', 'INT'],
  ['ads_is_estimate', 'BOOLEAN'],
  ['ads_advertisers', 'JSONB'],
  ['ads_checked_at', 'TIMESTAMP'],
];

/** Are the ads_* columns present on contacts? */
async function contactColumnsPresent(db) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='contacts' AND column_name LIKE 'ads_%'`);
  const have = new Set(rows.map((r) => r.column_name));
  return CONTACT_COLUMNS.every(([c]) => have.has(c));
}

/**
 * Indexes for the ads columns. Created HERE, after the columns are confirmed —
 * db-postgres builds its index list at init in parallel with the column
 * migration, so idx_contacts_ads_runs_ads raced the ALTER, failed with a
 * warning, and was never retried (indexes are only built at startup).
 */
async function ensureContactIndexes(db) {
  const idx = [
    `CREATE INDEX IF NOT EXISTS idx_contacts_ads_runs_ads ON contacts (ads_runs_ads) WHERE ads_runs_ads IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_domain_norm ON contacts (${DOMAIN_NORM_SQL})`,
  ];
  for (const sql of idx) {
    try { await db.query(sql); }
    catch (e) { console.warn('[ads] index build failed:', e.message.slice(0, 120)); }
  }
}

/**
 * Add the ads_* columns to contacts, retrying around lock contention.
 * ADD COLUMN with no default is instant in PG11+ once the lock is granted — the
 * only hard part is getting it, so retry rather than give up silently.
 */
async function ensureContactColumns(db, { attempts = 5 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      if (await contactColumnsPresent(db)) return true;
      for (const [col, type] of CONTACT_COLUMNS) {
        await db.query(`SET lock_timeout = '15s'`);
        await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ${col} ${type}`);
      }
      if (await contactColumnsPresent(db)) {
        console.log('[ads] contacts ads_* columns ready');
        await ensureContactIndexes(db);
        return true;
      }
    } catch (err) {
      console.warn(`[ads] contacts column migration attempt ${i}/${attempts} failed:`, err.message.slice(0, 140));
    }
    await new Promise((r) => setTimeout(r, 5000 * i)); // back off past the busy window
  }
  console.error('[ads] could NOT add ads_* columns to contacts — the Contacts "Google Ads" filter will stay disabled');
  return false;
}

let ready = null;

/** Create the ads_* tables once per process. Returns the same promise on re-call. */
function ensureSchema(db) {
  if (!ready) {
    ready = db.query(DDL)
      .then(() => {
        // Also (re)try the contacts columns, once per process. Startup can lose
        // the lock race on a busy deploy, and this gives a second chance the
        // moment anyone opens the Ads Checker — no redeploy needed. Detached so
        // the request isn't held for the retry backoff.
        if (!ensureSchema._contactsKicked) {
          ensureSchema._contactsKicked = true;
          ensureContactColumns(db)
            .then((ok) => { db._hasAdsColumns = ok; })
            .catch(() => {});
        }
        return true;
      })
      .catch((err) => {
        ready = null; // let a later request retry (e.g. DB was briefly down)
        throw err;
      });
  }
  return ready;
}

module.exports = {
  ensureSchema, DDL, DOMAIN_NORM_SQL,
  CONTACT_COLUMNS, contactColumnsPresent, ensureContactColumns,
};
