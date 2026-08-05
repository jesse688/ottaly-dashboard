import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { ensureSchema, pool, getDomainContacts, getDomainMeta, saveCompany, stampContacts, getCompany } from './src/db.js'
import { resolveDomain, debugDomain } from './src/resolver.js'
import { chEnabled } from './src/ch.js'
import { runEngine, stopEngine, engineState, maybeAutostart } from './src/engine.js'
import { queueDepth, enqueueStaleDomains } from './src/db.js'

const PORT = Number(process.env.PORT) || 3100

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set')
  process.exit(1)
}

const app = express()
app.use(express.json())

// Background stamp job state (declared early so /status can report it).
const stampState = { running: false, done: 0, total: 0, contacts: 0, started_at: null, finished_at: null, error: null }

app.get('/health', (req, res) => res.json({ ok: true, ch: chEnabled(), pid: process.pid }))

// Operator dashboard.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')))

// Resolve ONE domain. Shadow mode by default: writes the companies row only.
// Pass ?stamp=1 to also stamp contacts.ch_* (Phase 3 behaviour).
app.post('/refresh', async (req, res) => {
  const domain = (req.query.domain || req.body?.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  if (!chEnabled()) return res.status(400).json({ error: 'COMPANIES_HOUSE_API_KEY not set' })
  const stamp = req.query.stamp === '1'
  try {
    const contacts = await getDomainContacts(domain)
    const meta = await getDomainMeta(domain)
    if (!contacts.length && !meta) return res.status(404).json({ error: 'no contacts for domain' })
    const t0 = Date.now()
    const result = await resolveDomain(domain, contacts, meta)
    await saveCompany(result)
    if (stamp && result.match_method !== 'none') await stampContacts(result)
    res.json({
      ok: true, domain, took_ms: Date.now() - t0, stamped: stamp,
      match_method: result.match_method, match_confidence: result.match_confidence,
      ch_company_number: result.ch_company_number || null,
      ch_company_name: result.ch_company_name || null,
      ch_company_status: result.ch_company_status || null,
      anchor: result.anchor_contact_id
        ? { contact_id: result.anchor_contact_id, matched_officer: result.anchor_officer_name }
        : null,
      business_owner: result.business_owner, business_owner_basis: result.business_owner_basis,
      psc_owners: result.psc_owners || null,
      building_owner: result.building_owner || null, building_owner_name: result.building_owner_name || null,
      ch_source_stats: result.ch_source_stats || null,
      seniors_considered: contacts.length,
    })
  } catch (e) {
    console.error('[refresh]', domain, e.message)
    res.status(500).json({ error: e.message })
  }
})

// Diagnostic: raw contact names vs CH officers/PSC + pairwise scores for a domain.
app.get('/debug', async (req, res) => {
  const domain = (req.query.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  try {
    const contacts = await getDomainContacts(domain)
    const meta = await getDomainMeta(domain)
    res.json(await debugDomain(domain, contacts, meta))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Read a resolved company row.
app.get('/company', async (req, res) => {
  const domain = (req.query.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  const row = await getCompany(domain)
  if (!row) return res.status(404).json({ error: 'not resolved yet' })
  res.json(row)
})

// Sample real domains that have named senior contacts + a company name + address,
// so the shadow test has domains the resolver can actually work on. Ordered to
// surface domains with several contacts (good propagation demos) first.
app.get('/sample-domains', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200)
  const maxc = Number(req.query.max) || 100000   // cap contacts-per-domain (find SMEs)
  const minc = Number(req.query.min) || 1
  // order: 'top' = most contacts first; 'sample' = spread across domains
  // alphabetically (id is a UUID, so MIN(id) is invalid — order by the group key).
  const order = req.query.order === 'top' ? 'named DESC, contacts DESC' : 'company_domain'
  try {
    const { rows } = await pool.query(
      `SELECT company_domain AS domain,
              MAX(company_name) AS company_name,
              COUNT(*) AS contacts,
              COUNT(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL) AS named
         FROM contacts
        WHERE company_domain IS NOT NULL AND company_domain <> ''
          AND company_name IS NOT NULL AND company_name <> ''
          AND company_address IS NOT NULL AND company_address <> ''
        GROUP BY company_domain
       HAVING COUNT(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL) >= 1
          AND COUNT(*) BETWEEN $2 AND $3
        ORDER BY ${order}
        LIMIT $1`, [limit, minc, maxc])
    res.json({ domains: rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Shadow-mode confidence report: how the resolved companies rows compare to the
// per-contact ch_company_number currently on contacts. Sanity check before stamping.
app.get('/status', async (req, res) => {
  try {
    const [{ rows: comp }, { rows: byMethod }] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS resolved,
                         COUNT(*) FILTER (WHERE ch_company_number IS NOT NULL) AS with_number
                    FROM companies`),
      pool.query(`SELECT match_method, match_confidence, COUNT(*) AS n
                    FROM companies GROUP BY 1,2 ORDER BY 3 DESC`),
    ])
    const depth = await queueDepth()
    res.json({
      ch: chEnabled(), resolved: +comp[0].resolved, with_number: +comp[0].with_number,
      by_method: byMethod, engine: engineState(), queue: depth, stamp: stampState,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Debug: officer-cache coverage. How many officers are loaded, and does a given
// company number have cached officers?
app.get('/debug-officers', async (req, res) => {
  try {
    const { rows: tot } = await pool.query(
      `SELECT COUNT(*)::bigint AS n, COUNT(*) FILTER (WHERE fetched_by_svc_at IS NOT NULL)::bigint AS svc FROM ch_directors`)
    const num = (req.query.company || '').toString().trim()
    let forCompany = null
    if (num) {
      const { rows } = await pool.query(
        `SELECT name, role, fetched_by_svc_at IS NOT NULL AS svc FROM ch_directors WHERE company_number = $1 LIMIT 10`, [num])
      forCompany = { count: rows.length, rows }
    }
    res.json({ total_directors: +tot[0].n, service_loaded: +tot[0].svc, forCompany })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Resolved companies list for the dashboard table. Optional ?q= search on
// domain/company/owner, ?method= filter, ?owner= filter, paged.
app.get('/companies', async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase()
  const method = (req.query.method || '').toString().trim()
  const owner = (req.query.owner || '').toString().trim()
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Math.max(Number(req.query.offset) || 0, 0)
  const where = []; const params = []
  if (q) { params.push('%' + q + '%'); where.push(`(LOWER(domain) LIKE $${params.length} OR LOWER(ch_company_name) LIKE $${params.length} OR LOWER(anchor_officer_name) LIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(psc_owners) o WHERE LOWER(o) LIKE $${params.length}))`) }
  if (method) { params.push(method); where.push(`match_method = $${params.length}`) }
  if (owner) { params.push(owner); where.push(`business_owner = $${params.length}`) }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  try {
    params.push(limit, offset)
    const { rows } = await pool.query(
      `SELECT domain, ch_company_number, ch_company_name, ch_company_status,
              match_method, match_confidence, anchor_officer_name,
              business_owner, business_owner_basis, psc_owners,
              building_owner, building_owner_name, building_site_count, last_refreshed_at
         FROM companies ${wsql}
        ORDER BY last_refreshed_at DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM companies ${wsql}`, params.slice(0, params.length - 2))
    res.json({ total: cnt[0].n, rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Bulk-stamp ALL already-resolved companies onto contacts in one SQL pass — gets
// ownership data into the admin-legacy Contacts page immediately without waiting
// for the engine to re-resolve. Idempotent; safe to re-run.
// Bulk-stamp resolved companies onto contacts, BATCHED and in the BACKGROUND so a
// full-DB stamp completes reliably instead of hanging one giant UPDATE over HTTP.
// Processes companies in chunks (by domain), only re-stamping companies resolved
// more recently than the last stamp (so re-runs are cheap). Progress on /status.
app.get('/stamp-status', (req, res) => res.json(stampState))

// Full-DB backfill: stamp every resolved company's ownership onto its contacts.
// The engine already stamps per-resolve (STAMP on), so this is the manual bulk
// pass. Two hard-won perf rules baked in:
//  1) Count with a PLAIN COUNT(*) — the old correlated `NOT EXISTS
//     (…contacts…since last stamp)` filter probed the contacts table once per
//     company and wedged for minutes before the first batch even ran (no fast
//     index for that probe). Re-stamping is idempotent and cheap, so we just
//     stamp everything rather than compute an expensive "what changed" set.
//  2) KEYSET pagination (domain > lastDomain), not LIMIT/OFFSET — OFFSET rescans
//     all prior rows each batch (O(n²) over 195k). The PRIMARY KEY on domain makes
//     `WHERE domain > $1 ORDER BY domain` an index range scan, flat per batch.
async function runStampAll() {
  if (stampState.running) return
  Object.assign(stampState, { running: true, done: 0, total: 0, contacts: 0, started_at: new Date().toISOString(), finished_at: null, error: null })
  // Dedicated client so we can set a lock_timeout: if some other session holds a
  // conflicting lock on `contacts` (an idle-in-transaction admin query, a schema
  // ALTER, etc.), the batch UPDATE fails FAST and loud instead of hanging forever
  // at done:0 with no signal (which is exactly how the first attempts silently
  // stalled). The error surfaces on /stamp-status so we can see and clear the blocker.
  const client = await pool.connect()
  try {
    await client.query(`SET lock_timeout = '20s'`)
    // Force the contacts(company_domain) index. Even with a VALID index present, the
    // planner kept choosing a full seq scan of contacts per batch (~80s, IO-bound) —
    // stale stats after the bulk loads make it mis-estimate the 2000-key join. Refresh
    // stats AND hard-disable seqscan on this dedicated connection so every batch UPDATE
    // is a nested-loop index scan (ms). Scoped to this client only; the engine/others
    // are unaffected.
    await client.query(`ANALYZE contacts`).catch((e) => console.warn('[stamp] analyze:', e.message))
    await client.query(`SET enable_seqscan = off`)
    const totalRow = await client.query(`SELECT COUNT(*)::int AS n FROM companies`)
    stampState.total = totalRow.rows[0].n
    const BATCH = 2000
    let last = '' // keyset cursor: last domain stamped (domains sort > '')
    while (true) {
      const { rows } = await client.query(
        `SELECT domain FROM companies WHERE domain > $1 ORDER BY domain LIMIT $2`, [last, BATCH])
      if (!rows.length) break
      const domains = rows.map((r) => r.domain)
      const upd = await client.query(`
        UPDATE contacts ct SET
          ch_company_number = co.ch_company_number,
          ch_match_confidence = co.match_confidence,
          ch_postcode = COALESCE(co.ch_postcode, ct.ch_postcode),
          ch_verified_at = now(),
          ccod_owns_building = co.building_owner,
          ccod_building_owner = co.building_owner_name,
          business_owner = co.business_owner,
          business_owner_basis = co.business_owner_basis,
          psc_owners = co.psc_owners,
          company_data_provenance = CASE WHEN ct.id::text = co.anchor_contact_id THEN 'anchor'
                                         WHEN co.ch_company_number IS NULL THEN 'unresolved'
                                         ELSE 'inherited' END,
          company_stamped_at = now()
        FROM companies co
        -- Filter the TARGET table (ct) directly by the indexed column against the
        -- 2000-domain array. The old form filtered co.domain = ANY(...) and joined ct
        -- via ct.company_domain = co.domain, which the planner kept satisfying with a
        -- FULL SEQ SCAN of contacts per batch (~80s). Putting ct.company_domain = ANY($1)
        -- gives Postgres a direct index predicate on idx_contacts_company_domain — the
        -- same fast access path the single-domain stampContacts uses — so each batch is
        -- an index scan over just those domains, not the whole table.
        WHERE ct.company_domain = ANY($1) AND co.domain = ct.company_domain`, [domains])
      stampState.contacts += upd.rowCount
      stampState.done += domains.length
      last = domains[domains.length - 1] // advance the cursor
    }
  } catch (e) { stampState.error = e.message } finally {
    client.release()
    stampState.running = false; stampState.finished_at = new Date().toISOString()
  }
}

app.post('/stamp-all', (req, res) => {
  runStampAll().catch((e) => console.error('[stamp]', e.message))
  res.json({ ok: true, started: true, note: 'stamping in background — poll /stamp-status' })
})

// One-shot: create the admin-legacy solar_* result columns on `contacts`. The
// admin boot migration adds them with a 5s lock_timeout, which can't win the
// AccessExclusive lock on the busy contacts table, so they silently never got
// created (→ every solar save threw "column doesn't exist"). This adds ALL columns
// in a SINGLE ALTER (one lock, not 12) and RETRIES until it grabs a quiet moment.
app.post('/add-solar-columns', async (req, res) => {
  const sql = `ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS solar_checked_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS solar_status       TEXT,
    ADD COLUMN IF NOT EXISTS solar_stop_reason  TEXT,
    ADD COLUMN IF NOT EXISTS solar_max_kwp       INT,
    ADD COLUMN IF NOT EXISTS solar_panels        INT,
    ADD COLUMN IF NOT EXISTS solar_annual_kwh    INT,
    ADD COLUMN IF NOT EXISTS solar_roof_area_m2  INT,
    ADD COLUMN IF NOT EXISTS solar_has_solar     TEXT,
    ADD COLUMN IF NOT EXISTS solar_lat           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS solar_lng           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS solar_roof_address  TEXT,
    ADD COLUMN IF NOT EXISTS solar_maps_url      TEXT,
    ADD COLUMN IF NOT EXISTS solar_imagery_date  TEXT`
  let lastErr = null
  for (let i = 0; i < 15; i++) {
    const c = await pool.connect()
    try {
      await c.query(`SET lock_timeout = '4s'`)
      await c.query(sql)
      c.release()
      return res.json({ ok: true, attempts: i + 1 })
    } catch (e) {
      lastErr = e.message
      c.release()
      await new Promise((r) => setTimeout(r, 3000)) // let readers drain, then retry
    }
  }
  res.status(500).json({ ok: false, error: lastErr })
})

// Diagnostic (shared DB): do the admin-legacy solar_* columns exist, and are the
// solar results actually being persisted? Confirms whether the Solar page's
// enrichment caching is landing writes without needing psql access.
app.get('/solar-diag', async (req, res) => {
  try {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='contacts' AND column_name LIKE 'solar_%' ORDER BY column_name`)
    const hasCol = cols.rows.some((r) => r.column_name === 'solar_checked_at')
    let counts = null
    if (hasCol) {
      const c = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE solar_checked_at IS NOT NULL)::int AS checked,
                COUNT(*) FILTER (WHERE solar_status='qualified')::int AS qualified,
                MAX(solar_checked_at) AS last_checked
           FROM contacts`)
      counts = c.rows[0]
    }
    res.json({ ok: true, solar_columns: cols.rows.map((r) => r.column_name), has_solar_checked_at: hasCol, counts })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Is the contacts.company_domain index built and VALID? A CONCURRENTLY build takes
// a while on the full table and leaves an INVALID index if it fails partway, so the
// stamp should wait for valid=true before running (else it seq-scans per batch).
app.get('/index-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.relname AS index, i.indisvalid AS valid, i.indisready AS ready
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_contacts_company_domain'`)
    res.json({ ok: true, exists: rows.length > 0, valid: rows[0]?.valid ?? false, ready: rows[0]?.ready ?? false })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Manually (re)build the contacts.company_domain index — drops an INVALID leftover
// first, then rebuilds CONCURRENTLY. Fire-and-forget; poll /index-status for valid.
app.post('/reindex-contacts', (req, res) => {
  ;(async () => {
    try {
      await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_company_domain`).catch(() => {})
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_company_domain ON contacts (company_domain)`)
      console.log('[reindex] idx_contacts_company_domain built')
    } catch (e) { console.error('[reindex]', e.message) }
  })()
  res.json({ ok: true, started: true, note: 'building idx_contacts_company_domain concurrently — poll /index-status' })
})

// DB introspection — what's active and what's blocking whom. Lets us diagnose a
// stuck stamp (the UPDATE queues behind whoever holds a conflicting lock on
// `contacts`) without shell/psql access to the EasyPanel Postgres.
app.get('/pg-activity', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pid, state,
             now() - xact_start  AS xact_age,
             now() - query_start AS query_age,
             wait_event_type, wait_event,
             pg_blocking_pids(pid) AS blocked_by,
             left(query, 200) AS query
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND state IS NOT NULL AND state <> 'idle'
       ORDER BY xact_start NULLS LAST`)
    res.json({ ok: true, activity: rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cancel (default) or terminate a backend by pid — to clear a blocker holding a
// lock on `contacts`. ?terminate=1 uses pg_terminate_backend (harder kill).
app.post('/pg-kill', async (req, res) => {
  const pid = Number(req.query.pid)
  if (!pid) return res.status(400).json({ error: 'pid required' })
  const fn = req.query.terminate === '1' ? 'pg_terminate_backend' : 'pg_cancel_backend'
  try {
    const { rows } = await pool.query(`SELECT ${fn}($1) AS ok`, [pid])
    res.json({ ok: true, fn, pid, result: rows[0].ok })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Lead pipeline ──
// Common Crawl domain discovery → scrape → emails. Read-only view over
// scrape_jobs / scrape_job_items / scraped_contacts, which scraper-service
// owns. Nothing here writes; it exists so the funnel is visible in one place
// rather than only in psql.
app.get('/lead-pipeline', async (req, res) => {
  try {
    const [funnel, jobs, recent, split] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM scraped_contacts)                                  AS scraped,
          (SELECT COUNT(*) FROM scraped_contacts WHERE array_length(emails,1) > 0) AS with_email,
          (SELECT COUNT(*) FROM scraped_contacts WHERE status = 'no_contact')      AS no_contact,
          (SELECT COUNT(*) FROM scraped_contacts WHERE status = 'error')           AS errored,
          (SELECT COUNT(*) FROM scrape_job_items WHERE status = 'pending')         AS queued,
          (SELECT COALESCE(SUM(array_length(emails,1)),0) FROM scraped_contacts)   AS emails_total`),
      pool.query(`
        SELECT id, label, status, total, done, ok, failed, created_at
          FROM scrape_jobs ORDER BY id DESC LIMIT 10`),
      pool.query(`
        SELECT domain, emails, status, scraped_at
          FROM scraped_contacts
         WHERE array_length(emails,1) > 0
         ORDER BY scraped_at DESC LIMIT 25`),
      // Role vs named drives the PECR posture (a role address at a limited
      // company is a corporate subscriber), so surface the split up front.
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE e ~* '^(info|hello|enquiries|enquiry|admin|contact|office|mail|reception|sales|support|team|accounts|bookings)@') AS role,
          COUNT(*) FILTER (WHERE e !~* '^(info|hello|enquiries|enquiry|admin|contact|office|mail|reception|sales|support|team|accounts|bookings)@') AS named
          FROM (SELECT unnest(emails) AS e FROM scraped_contacts) x`),
    ])
    const f = funnel.rows[0]
    const s = split.rows[0]
    const scraped = +f.scraped
    res.json({
      funnel: {
        scraped, queued: +f.queued, with_email: +f.with_email,
        no_contact: +f.no_contact, errored: +f.errored, emails_total: +f.emails_total,
        yield_pct: scraped ? Math.round((1000 * +f.with_email) / scraped) / 10 : 0,
      },
      split: { role: +s.role, named: +s.named },
      jobs: jobs.rows,
      recent: recent.rows,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Lead pipeline auto-queue ──
// Keeps scraper-service fed from cc_domains (Common Crawl domains matched to
// Companies House). Without this the queue has to be topped up by hand from a
// workstation, which does not scale to ~800k domains.
//
// LOW_WATER/BATCH are deliberately conservative: a pending backlog is wasted
// work if the batch turns out to be bad, and scraper-service claims one job at
// a time anyway.
const AUTOQ = {
  enabled: process.env.LEAD_AUTOQUEUE !== '0',
  lowWater: Number(process.env.LEAD_QUEUE_LOW_WATER || 2000),
  batch: Number(process.env.LEAD_QUEUE_BATCH || 5000),
  // Hard ceiling on unfinished jobs. scraper-service works one job at a time,
  // so beyond a small number these are just sitting idle, and a big backlog is
  // wasted work if a batch turns out to be bad.
  maxOpenJobs: Number(process.env.LEAD_QUEUE_MAX_JOBS || 2),
  lastRun: null, lastQueued: 0, lastError: null,
}

/** Move `n` unqueued cc_domains rows into a new scrape job. Returns how many. */
async function topUpLeadQueue(n) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // FOR UPDATE SKIP LOCKED so two concurrent top-ups can't claim the same
    // domains. 'exact' first — see cc-match notes on tier quality.
    const { rows: picks } = await client.query(`
      SELECT domain, company_number, company_name
        FROM cc_domains
       WHERE queued_at IS NULL
       ORDER BY CASE confidence WHEN 'exact' THEN 1 WHEN 'pdl' THEN 2
                                WHEN 'first2' THEN 3 ELSE 4 END, domain
       LIMIT $1
         FOR UPDATE SKIP LOCKED`, [n])
    if (!picks.length) { await client.query('ROLLBACK'); return 0 }

    const { rows: [job] } = await client.query(
      `INSERT INTO scrape_jobs (label, status, total, source, fields)
       VALUES ($1,'queued',$2,'list',$3) RETURNING id`,
      [`auto: commoncrawl ${new Date().toISOString().slice(0, 10)}`, picks.length,
       ['emails', 'phones', 'address']])

    const vals = [], params = []
    picks.forEach((p, i) => {
      const o = i * 4
      vals.push(`($${o+1},$${o+2},$${o+3},$${o+4})`)
      params.push(job.id, p.company_number, p.company_name, p.domain)
    })
    await client.query(
      `INSERT INTO scrape_job_items (job_id, company_number, company_name, domain)
       VALUES ${vals.join(',')}`, params)

    await client.query(
      `UPDATE cc_domains SET queued_at = now() WHERE domain = ANY($1)`,
      [picks.map(p => p.domain)])

    await client.query('COMMIT')
    return picks.length
  } catch (e) {
    await client.query('ROLLBACK'); throw e
  } finally { client.release() }
}

app.get('/lead-queue/status', async (req, res) => {
  try {
    const { rows: [d] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM cc_domains)                        AS total,
             (SELECT COUNT(*) FROM cc_domains WHERE queued_at IS NULL) AS remaining,
             (SELECT COUNT(*) FROM scrape_job_items WHERE status='pending') AS pending,
             (SELECT COUNT(*) FROM scrape_jobs WHERE status IN ('queued','running')) AS open_jobs`)
    res.json({
      total: +d.total, remaining: +d.remaining, pending: +d.pending, open_jobs: +d.open_jobs,
      auto: { enabled: AUTOQ.enabled, low_water: AUTOQ.lowWater, batch: AUTOQ.batch,
              max_open_jobs: AUTOQ.maxOpenJobs,
              last_run: AUTOQ.lastRun, last_queued: AUTOQ.lastQueued, last_error: AUTOQ.lastError },
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/lead-queue/top-up', async (req, res) => {
  try {
    const n = await topUpLeadQueue(Math.min(Number(req.query.limit) || AUTOQ.batch, 25000))
    res.json({ ok: true, queued: n })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/lead-queue/auto', (req, res) => {
  AUTOQ.enabled = req.query.on !== '0'
  res.json({ ok: true, enabled: AUTOQ.enabled })
})

// Poll every 60s: top up only when the queue has drained below the low-water
// mark, so this is a no-op almost every tick.
setInterval(async () => {
  if (!AUTOQ.enabled) return
  try {
    // Gate on UNFINISHED JOBS, not pending items. scraper-service claims one job
    // at a time, so a backlog of queued jobs is work already waiting — topping
    // up because item count looks low just grows a queue nothing is draining.
    const { rows: [q] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status IN ('queued','running')) AS open_jobs,
             COALESCE(SUM(total - done) FILTER (WHERE status IN ('queued','running')),0) AS outstanding
        FROM scrape_jobs`)
    if (+q.open_jobs >= AUTOQ.maxOpenJobs) return
    if (+q.outstanding >= AUTOQ.lowWater) return
    const n = await topUpLeadQueue(AUTOQ.batch)
    AUTOQ.lastRun = new Date().toISOString(); AUTOQ.lastQueued = n; AUTOQ.lastError = null
    if (n) console.log(`[lead-queue] topped up ${n} (open jobs ${q.open_jobs}, outstanding ${q.outstanding})`)
  } catch (e) {
    AUTOQ.lastError = e.message
    console.error('[lead-queue]', e.message)
  }
}, 60000)

// ── Continuous engine controls ──
app.post('/engine/start', (req, res) => {
  runEngine().catch((e) => console.error('[engine]', e.message))
  res.json({ ok: true, engine: engineState() })
})
app.post('/engine/stop', (req, res) => {
  stopEngine()
  res.json({ ok: true, engine: engineState() })
})
// Manually top up the queue (useful to seed a capped test batch without running).
app.post('/engine/enqueue', async (req, res) => {
  try {
    const n = await enqueueStaleDomains(Number(req.query.limit) || 500)
    res.json({ ok: true, enqueued: n, queue: await queueDepth() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Listen FIRST, migrate schema in the BACKGROUND. ensureSchema() runs blocking DDL
// (incl. ALTER COLUMN ... TYPE, which takes an ACCESS EXCLUSIVE lock and table
// rewrite). If a prior container or an in-flight stamp still holds a lock on
// `companies`/`contacts`, that ALTER blocks indefinitely — the old
// ensureSchema().then(listen) ordering then never bound the port, so EasyPanel saw
// no healthy process and the deploy crash-looped into a 502. Binding the port up
// front keeps /health responsive no matter what the DB is doing; the migration
// (long since a no-op in prod) settles behind it, and a failure is logged, not fatal.
app.listen(PORT, () => console.log(`[company-service] listening on ${PORT} — shadow mode (POST /refresh?domain=)`))

ensureSchema()
  .then(() => {
    console.log(`[company-service] schema ensured, CH ${chEnabled() ? 'enabled' : 'DISABLED (no key)'}`)
    maybeAutostart() // starts the continuous engine only if ENGINE_ENABLED is set
  })
  .catch((e) => console.error('[company-service] ensureSchema failed (server still up):', e.message))
