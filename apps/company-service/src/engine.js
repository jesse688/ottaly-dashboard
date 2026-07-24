// Continuous refresh engine. Mirrors scraper-service's worker: a forever loop that
// claims the highest-priority queued domain (SKIP LOCKED), resolves it, saves the
// companies row, and — when the queue drains — re-enqueues the stalest domains so
// it loops indefinitely (CH data goes stale: dissolutions, new officers, ownership
// changes). SHADOW MODE: writes the companies table only; does NOT stamp contacts.
//
// Controlled by ENGINE_ENABLED (default off so a deploy doesn't auto-start a
// days-long run) and a runtime flag toggled via /engine/start|stop.

import {
  claimNextRefreshJob, finishRefreshJob, requeueRunning, enqueueStaleDomains,
  queueDepth, getDomainContacts, getDomainMeta, saveCompany,
} from './db.js'
import { resolveDomain } from './resolver.js'

const IDLE_POLL_MS = Number(process.env.ENGINE_IDLE_POLL_MS) || 5000
const ENQUEUE_BATCH = Number(process.env.ENGINE_ENQUEUE_BATCH) || 500
// Most domains now resolve fully-LOCAL (~7ms); only the minority missing from the
// bulk register hit the API (~550ms, CH-throttled). With low concurrency those few
// slow API domains starve the fast local ones. Higher concurrency lets many local
// resolves fly in parallel while the CH throttle still serialises the API calls.
const CONCURRENCY = Number(process.env.ENGINE_CONCURRENCY) || 16

const state = {
  running: false,          // is the loop active
  processed: 0, resolved: 0, failed: 0,
  last_domain: null, started_at: null, error: null,
}
export function engineState() { return { ...state } }

let _stop = false
export function stopEngine() { _stop = true; state.running = false }

async function processOne(job) {
  state.last_domain = job.domain
  try {
    const contacts = await getDomainContacts(job.domain)
    const meta = await getDomainMeta(job.domain)
    if (!contacts.length && !meta) { await finishRefreshJob(job.id, null); state.processed++; return }
    const result = await resolveDomain(job.domain, contacts, meta)
    await saveCompany(result)              // SHADOW: companies only, no contact stamping
    if (result.match_method && result.match_method !== 'none') state.resolved++
    await finishRefreshJob(job.id, null)
  } catch (e) {
    state.failed++
    await finishRefreshJob(job.id, e.message).catch(() => {})
  }
  state.processed++
}

async function worker() {
  while (!_stop) {
    let job
    try { job = await claimNextRefreshJob() } catch { await sleep(IDLE_POLL_MS); continue }
    if (!job) return // queue empty for this worker — let the loop top up
    await processOne(job)
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// The forever loop: top up the queue, run a wave of workers until it drains, repeat.
export async function runEngine() {
  if (state.running) return
  _stop = false
  state.running = true
  state.started_at = state.started_at || new Date().toISOString()
  state.error = null
  try {
    await requeueRunning() // recover crash-interrupted jobs
    while (!_stop) {
      const enq = await enqueueStaleDomains(ENQUEUE_BATCH)
      const depth = await queueDepth()
      if (!depth.queued) {
        // Nothing to do right now — wait, then re-check (a full pass is done;
        // staleness ordering will re-surface the oldest domains next top-up).
        await sleep(IDLE_POLL_MS)
        continue
      }
      // Drain the current queue with a wave of concurrent workers.
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    }
  } catch (e) {
    state.error = e.message
  } finally {
    state.running = false
  }
}

// Auto-start only if explicitly enabled (never auto-run a days-long job on deploy).
export function maybeAutostart() {
  if (/^(1|true|yes|on)$/i.test(process.env.ENGINE_ENABLED || '')) {
    console.log('[engine] ENGINE_ENABLED set — starting continuous refresh')
    runEngine().catch((e) => console.error('[engine]', e.message))
  }
}
