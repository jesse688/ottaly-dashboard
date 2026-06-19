import {
  ensureSchema, claimNextJob, loadPendingItems, saveContact,
  writeBackDomain, markItem, bumpJob, finishJob, pool,
} from './db.js'
import { discoverDomain } from './discover.js'
import { scrapeBatch } from './scrape.js'
import { normaliseDomain } from './extract.js'

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10)
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '5000', 10)
const DISCOVERY_CONCURRENCY = parseInt(process.env.DISCOVERY_CONCURRENCY || '10', 10)

function log(...a) { console.log(new Date().toISOString(), ...a) }

// Run async fn over items with bounded concurrency.
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

async function processJob(job) {
  log(`▶ job ${job.id} "${job.label || ''}" started`)

  while (true) {
    const items = await loadPendingItems(job.id, BATCH_SIZE)
    if (items.length === 0) break

    // 1) Resolve domains. Discover for any item without one.
    await mapPool(items, DISCOVERY_CONCURRENCY, async (item) => {
      if (item.domain) {
        item.domain = normaliseDomain(item.domain)
        return
      }
      const found = await discoverDomain(item.company_name)
      if (found) {
        item.domain = found
        item._discovered = true
      }
    })

    const scrapeable = items.filter(it => it.domain)
    const undiscovered = items.filter(it => !it.domain)

    // 2) Items we couldn't find a domain for: mark failed, no scrape.
    for (const it of undiscovered) {
      await markItem(it.id, 'error', null)
      await bumpJob(job.id, { failedDelta: 1, doneDelta: 1 })
    }

    // 3) Scrape everything that has a domain.
    if (scrapeable.length) {
      const results = await scrapeBatch(
        scrapeable.map(it => ({ domain: it.domain, company_number: it.company_number }))
      )
      for (const it of scrapeable) {
        const r = results.get(it.domain)
        try {
          if (r) {
            await saveContact(r)
            if (it._discovered) await writeBackDomain(it.company_number, it.domain)
          }
          const failed = !r || r.status === 'error'
          await markItem(it.id, failed ? 'error' : 'done', it.domain)
          await bumpJob(job.id, { okDelta: failed ? 0 : 1, failedDelta: failed ? 1 : 0, doneDelta: 1 })
        } catch (err) {
          log(`  ! save failed for ${it.domain}: ${err.message}`)
          await markItem(it.id, 'error', it.domain)
          await bumpJob(job.id, { failedDelta: 1, doneDelta: 1 })
        }
      }
    }

    log(`  job ${job.id}: processed ${items.length} (scraped ${scrapeable.length}, no-domain ${undiscovered.length})`)
  }

  await finishJob(job.id, null)
  log(`✓ job ${job.id} done`)
}

export async function runWorker() {
  await ensureSchema()
  log('scraper-service ready — schema ensured, polling for jobs')

  // Recover any job left 'running' by a crash: its pending items will be picked
  // up again here since we re-select pending rows.
  await pool.query(`UPDATE scrape_jobs SET status = 'queued' WHERE status = 'running'`)

  while (true) {
    let job
    try {
      job = await claimNextJob()
    } catch (err) {
      log('claimNextJob error:', err.message)
      await new Promise(r => setTimeout(r, IDLE_POLL_MS))
      continue
    }
    if (!job) {
      await new Promise(r => setTimeout(r, IDLE_POLL_MS))
      continue
    }
    try {
      await processJob(job)
    } catch (err) {
      log(`✗ job ${job.id} failed:`, err.message)
      await finishJob(job.id, err.message).catch(() => {})
    }
  }
}
