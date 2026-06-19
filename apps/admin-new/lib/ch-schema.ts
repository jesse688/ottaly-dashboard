import pool from '@/lib/db'

// The scraper-service owns these tables, but the dashboard may query/insert
// before the worker has ever booted. Same IF NOT EXISTS DDL on both sides;
// memoized so it runs at most once per server process.
let ensured: Promise<void> | null = null

export function ensureScrapeSchema(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(`
        CREATE TABLE IF NOT EXISTS scraped_contacts (
          domain         TEXT PRIMARY KEY,
          company_number TEXT,
          page_url       TEXT,
          emails         TEXT[] NOT NULL DEFAULT '{}',
          phones         TEXT[] NOT NULL DEFAULT '{}',
          raw_names      TEXT[] NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL DEFAULT 'ok',
          error_msg      TEXT,
          scraped_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_scraped_company ON scraped_contacts(company_number);

        CREATE TABLE IF NOT EXISTS scrape_jobs (
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
        );
        CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status);

        CREATE TABLE IF NOT EXISTS scrape_job_items (
          id             SERIAL PRIMARY KEY,
          job_id         INTEGER NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
          company_number TEXT,
          company_name   TEXT,
          domain         TEXT,
          status         TEXT NOT NULL DEFAULT 'pending',
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_job_items_job ON scrape_job_items(job_id);
      `)
      .then(() => undefined)
      .catch((err) => {
        ensured = null // allow retry on next request
        throw err
      })
  }
  return ensured
}
