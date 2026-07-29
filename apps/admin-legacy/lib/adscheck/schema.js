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
  batch_id   uuid   NOT NULL REFERENCES ads_batches(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL,
  domain     text   NOT NULL,
  PRIMARY KEY (batch_id, contact_id)
);
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

let ready = null;

/** Create the ads_* tables once per process. Returns the same promise on re-call. */
function ensureSchema(db) {
  if (!ready) {
    ready = db.query(DDL)
      .then(() => true)
      .catch((err) => {
        ready = null; // let a later request retry (e.g. DB was briefly down)
        throw err;
      });
  }
  return ready;
}

module.exports = { ensureSchema, DDL, DOMAIN_NORM_SQL };
