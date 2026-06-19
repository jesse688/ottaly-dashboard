import {
  ensureSchema, claimNextJob, loadPendingItems, saveContact, getCompanyContext,
  writeBackDomain, markItem, bumpJob, finishJob, pool,
} from './db.js'
import { discoverDomain } from './discover.js'
import { scrapeBatch } from './scrape.js'
import { normaliseDomain } from './extract.js'
import { normaliseFields, wantsClaude, CLAUDE_FIELD_KEYS } from './fields.js'
import { classifyBusiness, classifierAvailable, classifierProvider } from './classify.js'

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10)
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '5000', 10)
const DISCOVERY_CONCURRENCY = parseInt(process.env.DISCOVERY_CONCURRENCY || '10', 10)
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || '6', 10)

// Assemble the row to save, populating ONLY the fields the user ticked.
function buildContact(r, context, cls, fields) {
  const has = (f) => fields.includes(f)
  return {
    domain: r.domain,
    company_number: r.company_number,
    pageUrl: r.pageUrl,
    website: r.website,
    status: r.status,
    errorMsg: r.errorMsg,
    names: r.names, // always kept — cheap and useful
    emails: has('emails') ? r.emails : [],
    phones: has('phones') ? r.phones : [],
    address: has('address') ? (r.address || context?.address || null) : null,
    socials: has('social_links') ? r.socials : null,
    description: has('description') ? r.description : null,
    business_type: has('business_type') ? (cls.business_type || context?.company_type || null) : null,
    industry: has('industry') ? (cls.industry || context?.industry || null) : null,
    keywords: has('keywords') ? (cls.keywords?.length ? cls.keywords : r.metaKeywords) : [],
  }
}

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
  const fields = normaliseFields(job.fields)
  const useClaude = wantsClaude(fields) && classifierAvailable
  const claudeKeys = CLAUDE_FIELD_KEYS.filter((k) => fields.includes(k))
  log(`▶ job ${job.id} "${job.label || ''}" started — source=${job.source} fields=[${fields.join(',')}]${useClaude ? ' +AI' : ''}`)
  if (wantsClaude(fields) && !classifierAvailable) {
    log(`  ! AI fields selected but ANTHROPIC_API_KEY is unset — they will be left blank`)
  }

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

    // 3) Scrape everything that has a domain, then enrich + classify per item.
    if (scrapeable.length) {
      const results = await scrapeBatch(
        scrapeable.map(it => ({ domain: it.domain, company_number: it.company_number }))
      )
      await mapPool(scrapeable, ENRICH_CONCURRENCY, async (it) => {
        const r = results.get(it.domain)
        try {
          if (!r) {
            await markItem(it.id, 'error', it.domain)
            await bumpJob(job.id, { failedDelta: 1, doneDelta: 1 })
            return
          }
          const context = await getCompanyContext(it.company_number)
          let classification = {}
          if (useClaude && r.status !== 'error') {
            classification = await classifyBusiness(
              {
                name: it.company_name,
                textSample: r.textSample,
                hints: { sic_codes: context?.sic_codes, company_type: context?.company_type },
              },
              claudeKeys
            )
          }
          await saveContact(buildContact(r, context, classification, fields))
          if (it._discovered) await writeBackDomain(it.company_number, it.domain)

          const failed = r.status === 'error'
          await markItem(it.id, failed ? 'error' : 'done', it.domain)
          await bumpJob(job.id, { okDelta: failed ? 0 : 1, failedDelta: failed ? 1 : 0, doneDelta: 1 })
        } catch (err) {
          log(`  ! enrich/save failed for ${it.domain}: ${err.message}`)
          await markItem(it.id, 'error', it.domain)
          await bumpJob(job.id, { failedDelta: 1, doneDelta: 1 })
        }
      })
    }

    log(`  job ${job.id}: processed ${items.length} (scraped ${scrapeable.length}, no-domain ${undiscovered.length})`)
  }

  await finishJob(job.id, null)
  log(`✓ job ${job.id} done`)
}

export async function runWorker() {
  await ensureSchema()
  log(`scraper-service ready — schema ensured, AI classifier=${classifierProvider}, polling for jobs`)

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
