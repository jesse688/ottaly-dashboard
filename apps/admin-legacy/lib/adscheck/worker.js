// Ads-checker queue worker.
//
// Runs in-process inside admin-legacy (same pattern as the enrichment and
// ch-verify jobs) rather than as a separate container. Claiming uses
// SELECT … FOR UPDATE SKIP LOCKED, so running two admin-legacy replicas gives
// two workers on the same queue for free — each takes a disjoint set of jobs.
//
// Durability:
//   • locked_at is refreshed by the heartbeat for every in-flight job, so the
//     stale sweep below only ever reclaims jobs whose worker actually died.
//   • On boot we immediately requeue anything still marked running under our
//     own worker id (we just restarted — none of it is really in flight).

const os = require('os');
const { BrowserPool } = require('./browser');
const { checkDomain, sleep } = require('./checkDomain');
const { DOMAIN_NORM_SQL } = require('./schema');

const HEARTBEAT_MS = 15 * 1000;
const SWEEP_MS = 60 * 1000;
const STALE_AFTER = '2 minutes';
const IDLE_SLEEP_MS = 3000;

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

class AdsWorker {
  constructor(db, opts = {}) {
    this.db = db;
    this.id = opts.id || `${process.env.ADS_WORKER_ID || os.hostname()}-${process.pid}`;
    this.concurrency = Math.max(1, Math.min(num(opts.concurrency ?? process.env.ADS_CONCURRENCY, 3), 8));
    this.maxRetries = num(opts.maxRetries ?? process.env.ADS_MAX_RETRIES, 4);
    this.jitterMin = num(process.env.ADS_JITTER_MIN_MS, 100);
    this.jitterMax = num(process.env.ADS_JITTER_MAX_MS, 500);
    this.cacheTtlDays = num(process.env.ADS_CACHE_TTL_DAYS, 7);
    this.browsers = new BrowserPool({ idleMs: num(process.env.ADS_BROWSER_IDLE_MS, 5 * 60 * 1000) });

    this.running = false;
    this.inFlight = new Set();   // job ids currently being processed
    this.doneRecent = [];        // completion timestamps, for the throughput readout
    this.lastError = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reclaimOwn().catch((e) => console.warn('[ads] boot reclaim failed:', e.message));
    this.timers = [
      setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_MS),
      setInterval(() => this.sweepStale().catch(() => {}), SWEEP_MS),
      setInterval(() => this.browsers.closeIfIdle().catch(() => {}), 60 * 1000),
    ];
    this.loop().catch((e) => {
      this.running = false;
      console.error('[ads] worker loop died:', e.message);
    });
    console.log(`[ads] worker ${this.id} started (concurrency ${this.concurrency}, retries ${this.maxRetries})`);
  }

  async stop() {
    this.running = false;
    (this.timers || []).forEach(clearInterval);
    await this.browsers.close();
  }

  // ── queue plumbing ────────────────────────────────────────

  /** Anything still 'running' under our id predates this process — requeue it. */
  async reclaimOwn() {
    const r = await this.db.query(
      `UPDATE ads_jobs SET status='queued', locked_at=NULL, locked_by=NULL, updated_at=now()
        WHERE status='running' AND locked_by=$1`, [this.id]);
    if (r.rowCount) console.log(`[ads] requeued ${r.rowCount} job(s) left running by a previous ${this.id}`);
  }

  /** Reclaim jobs whose worker stopped heartbeating. */
  async sweepStale() {
    const r = await this.db.query(
      `UPDATE ads_jobs SET status='queued', locked_at=NULL, locked_by=NULL, updated_at=now()
        WHERE status='running' AND locked_at < now() - interval '${STALE_AFTER}'`);
    if (r.rowCount) console.log(`[ads] reclaimed ${r.rowCount} stale job(s)`);
  }

  /** Publish liveness AND refresh the lock on everything we hold. */
  async heartbeat() {
    const ids = [...this.inFlight];
    if (ids.length) {
      await this.db.query(
        `UPDATE ads_jobs SET locked_at=now() WHERE id = ANY($1::bigint[]) AND locked_by=$2`,
        [ids, this.id]);
    }
    await this.db.query(
      `INSERT INTO ads_workers (id, in_flight, concurrency, browser_ok, note, last_heartbeat)
            VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (id) DO UPDATE SET in_flight=$2, concurrency=$3, browser_ok=$4, note=$5, last_heartbeat=now()`,
      [this.id, ids.length, this.concurrency, this.browsers.ok, this.browsers.lastError || this.lastError]);
  }

  /** Atomically take up to n queued jobs from non-paused batches. */
  async claim(n) {
    const { rows } = await this.db.query(
      `UPDATE ads_jobs j
          SET status='running', attempts=j.attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
        WHERE j.id IN (
          SELECT jj.id FROM ads_jobs jj
            JOIN ads_batches b ON b.id = jj.batch_id
           WHERE jj.status='queued' AND b.status='running'
           ORDER BY jj.id
           FOR UPDATE OF jj SKIP LOCKED
           LIMIT $2
        )
        RETURNING j.id, j.domain, j.batch_id, j.attempts,
                  (SELECT region FROM ads_batches WHERE id = j.batch_id) AS region`,
      [this.id, n]);
    return rows;
  }

  // ── job processing ────────────────────────────────────────

  async process(job) {
    let context;
    try {
      // Round-robins across the proxy contexts, so consecutive jobs leave from
      // different egress IPs. Falls back to the direct context when no proxy
      // list is configured.
      context = await this.browsers.nextContext();
    } catch (err) {
      // Browser can't launch (missing Chromium). Requeue rather than burning
      // the job through to 'error' — a redeploy with the binary should recover.
      this.lastError = `chromium unavailable: ${err.message}`;
      await this.db.query(
        `UPDATE ads_jobs SET status='queued', locked_at=NULL, locked_by=NULL,
                             attempts=GREATEST(attempts-1,0), error=$2, updated_at=now()
          WHERE id=$1`, [job.id, this.lastError.slice(0, 300)]);
      await sleep(15000); // don't hot-loop against a broken install
      return;
    }

    try {
      const res = await checkDomain(context, job.domain, {
        region: job.region || 'anywhere',
        maxRetries: this.maxRetries,
        jitterMin: this.jitterMin,
        jitterMax: this.jitterMax,
        onAttempt: () => this.db.query(`UPDATE ads_jobs SET locked_at=now() WHERE id=$1`, [job.id]),
      });

      await this.db.query(
        `UPDATE ads_jobs
            SET status='done', runs_ads=$2, ad_count=$3, is_estimate=$4, advertisers=$5::jsonb,
                error=NULL, updated_at=now()
          WHERE id=$1`,
        [job.id, res.runs_ads, res.ad_count, res.is_estimate, JSON.stringify(res.advertisers || [])]);

      if (this.cacheTtlDays > 0) {
        await this.db.query(
          `INSERT INTO ads_domain_cache (domain, region, runs_ads, ad_count, is_estimate, advertisers, checked_at)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
           ON CONFLICT (domain, region) DO UPDATE
             SET runs_ads=$3, ad_count=$4, is_estimate=$5, advertisers=$6::jsonb, checked_at=now()`,
          [job.domain, job.region || 'anywhere', res.runs_ads, res.ad_count, res.is_estimate,
           JSON.stringify(res.advertisers || [])]).catch(() => {});
      }
      await this.stampContacts(job.domain, res).catch(() => {}); // non-fatal
      this.lastError = null;
    } catch (err) {
      await this.db.query(
        `UPDATE ads_jobs SET status='error', error=$2, updated_at=now() WHERE id=$1`,
        [job.id, (err.message || String(err)).slice(0, 300)]);
    } finally {
      this.doneRecent.push(Date.now());
      if (this.doneRecent.length > 500) this.doneRecent.splice(0, this.doneRecent.length - 500);
      await this.markBatchDoneIfFinished(job.batch_id).catch(() => {});
    }
  }

  /**
   * Persist the result onto every contact at this domain, so the Contacts grid
   * can filter on it later and a push can be built from it — not just the
   * contacts that happened to be in this batch. Matches on the normalised
   * domain (lowered, www-stripped), which is the form ads_jobs.domain is in;
   * idx_contacts_domain_norm makes it an index lookup rather than a seq scan.
   */
  async stampContacts(domain, res) {
    await this.db.query(
      `UPDATE contacts
          SET ads_runs_ads=$2, ads_count=$3, ads_is_estimate=$4,
              ads_advertisers=$5::jsonb, ads_checked_at=now()
        WHERE ${DOMAIN_NORM_SQL} = $1`,
      [domain, res.runs_ads, res.ad_count, res.is_estimate, JSON.stringify(res.advertisers || [])]);
  }

  /** Flip a batch to 'done' once nothing is queued or running for it. */
  async markBatchDoneIfFinished(batchId) {
    await this.db.query(
      `UPDATE ads_batches b SET status='done'
        WHERE b.id=$1 AND b.status='running'
          AND NOT EXISTS (
            SELECT 1 FROM ads_jobs j WHERE j.batch_id=b.id AND j.status IN ('queued','running'))`,
      [batchId]);
  }

  async loop() {
    while (this.running) {
      const slots = this.concurrency - this.inFlight.size;
      let claimed = [];
      if (slots > 0) {
        try {
          claimed = await this.claim(slots);
        } catch (err) {
          this.lastError = err.message;
          await sleep(5000);
          continue;
        }
      }
      for (const job of claimed) {
        this.inFlight.add(job.id);
        this.process(job)
          .catch((e) => console.error('[ads] process crashed:', e.message))
          .finally(() => this.inFlight.delete(job.id));
      }
      // Poll fast while there's work; back off to a slow tick when idle.
      await sleep(claimed.length ? 250 : IDLE_SLEEP_MS);
    }
  }

  /** Jobs finished per minute over the last 5 minutes (this replica only). */
  throughput() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const recent = this.doneRecent.filter((t) => t > cutoff);
    return recent.length ? +(recent.length / 5).toFixed(1) : 0;
  }
}

module.exports = { AdsWorker };
