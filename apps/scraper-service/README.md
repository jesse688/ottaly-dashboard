# scraper-service

Background worker that finds and scrapes contact details (emails, phones, names)
for Companies House businesses and stores them in Postgres. Triggered from the
**CH** page in `admin-new`; runs on Easypanel (not Vercel — Crawlee is long-running).

## How it fits together

```
admin-new (CH page)  ──insert──▶  scrape_jobs + scrape_job_items   (Postgres)
                                          │
scraper-service (this) ──poll──▶  claims queued job, processes items
   1. resolve domain  (ch_companies.website, else discover from name)
   2. scrape homepage + /contact /about /team …  via rotating proxies
   3. upsert results ──▶  scraped_contacts
   4. update job progress (done / ok / failed)
                                          │
admin-new (CH page)  ──poll──▶  reads job progress + scraped_contacts
```

## Tables (auto-created on boot)

- `scraped_contacts` — one row per domain: `emails[]`, `phones[]`, `raw_names[]`, `status`, linked to `company_number`.
- `scrape_jobs` — one batch: `status` (queued→running→done/failed), `total/done/ok/failed`.
- `scrape_job_items` — one target company per job.

It only ever **reads** `ch_companies` (and optionally writes back a discovered
`website` + `domain_checked_at`). It does not alter the CH schema.

## Run locally

```bash
cp .env.example .env   # fill in DATABASE_URL + PROXY_LIST
npm install
npm start
```

## Deploy on Easypanel

1. New **App** service from this repo, build with the `Dockerfile` in this folder.
2. Set env vars: `DATABASE_URL`, `PROXY_LIST`, `MAX_CONCURRENCY`.
3. Deploy. It idles until the dashboard queues a job, then processes it.

Crash-safe: a job left `running` (e.g. container restart) is requeued on boot and
its still-`pending` items are picked up again.
