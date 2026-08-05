import {
  ensureSchema, claimNextJob, loadPendingItems, saveContact, getCompanyContext,
  writeBackDomain, markItem, bumpJob, finishJob, getJobStatus,
  existingScrapedDomains, beatJob, reclaimStalledJobs, pool,
} from './db.js'
import { discoverDomain } from './discover.js'
import { scrapeBatch, scrapeBatchPlaywright } from './scrape.js'
import { initProxies } from './proxies.js'
import { normaliseDomain } from './extract.js'
import { normaliseFields, wantsClaude, CLAUDE_FIELD_KEYS } from './fields.js'
import { classifyBusiness, classifierAvailable, classifierProvider } from './classify.js'

// Batch size interacts with Crawlee's autoscaling: the pool ramps up every 10s
// in small steps, so a short batch finishes while concurrency is still climbing
// and the next batch starts from the floor again. Bigger batches amortise that
// ramp. Progress is written at batch boundaries, so this also sets how often the
// dashboard moves — 500 is the compromise.
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '500', 10)
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '5000', 10)
const DISCOVERY_CONCURRENCY = parseInt(process.env.DISCOVERY_CONCURRENCY || '10', 10)
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || '6', 10)
// Opt-in: retry blocked/empty domains with a real browser. Needs the Playwright
// image + ≥2GB RAM. Off by default so a small container isn't overwhelmed.
const PLAYWRIGHT_FALLBACK = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_FALLBACK || '')

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
  // Beat on a TIMER, not at batch boundaries. A batch of 500 domains can crawl
  // for longer than JOB_STALE_SECS, so a boundary-only heartbeat goes silent
  // mid-batch and the reclaimer requeues a perfectly healthy job — the exact
  // failure the heartbeat was added to prevent.
  await beatJob(job.id).catch(() => {})   // stamp immediately, don't wait 30s
  const beat = setInterval(() => {
    beatJob(job.id).catch(err => log('heartbeat error:', err.message))
  }, 30000)
  beat.unref()
  try {
    return await processJobInner(job)
  } finally {
    clearInterval(beat)
  }
}

async function processJobInner(job) {
  const fields = normaliseFields(job.fields)
  const useClaude = wantsClaude(fields) && classifierAvailable
  const claudeKeys = CLAUDE_FIELD_KEYS.filter((k) => fields.includes(k))
  log(`▶ job ${job.id} "${job.label || ''}" started — source=${job.source} fields=[${fields.join(',')}]${useClaude ? ' +AI' : ''}`)
  if (wantsClaude(fields) && !classifierAvailable) {
    log(`  ! AI fields selected but ANTHROPIC_API_KEY is unset — they will be left blank`)
  }

  while (true) {
    // Stop promptly if the dashboard cancelled this job mid-run.
    if (await getJobStatus(job.id) === 'cancelled') {
      log(`■ job ${job.id} cancelled — stopping`)
      return
    }
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

    const withDomain = items.filter(it => it.domain)
    const undiscovered = items.filter(it => !it.domain)

    // 2) Items we couldn't find a domain for: mark failed, no scrape.
    for (const it of undiscovered) {
      await markItem(it.id, 'error', null)
      await bumpJob(job.id, { failedDelta: 1, doneDelta: 1 })
    }

    // 2b) DEDUP: skip any domain we've ALREADY scraped — reuse the stored row,
    // no re-crawl. Saves proxy bandwidth + Gemini cost and means we never scrape
    // the same business twice. (Link CH company_number to the existing row.)
    const known = await existingScrapedDomains(withDomain.map(it => it.domain))
    const alreadyScraped = withDomain.filter(it => known.has(it.domain))
    const scrapeable = withDomain.filter(it => !known.has(it.domain))
    for (const it of alreadyScraped) {
      if (it.company_number) await writeBackDomain(it.company_number, it.domain)
      await markItem(it.id, 'done', it.domain)
      await bumpJob(job.id, { okDelta: 1, doneDelta: 1 })
    }
    if (alreadyScraped.length) {
      log(`  job ${job.id}: skipped ${alreadyScraped.length} already-scraped domain(s)`)
    }

    // 3) Scrape everything NEW that has a domain, then enrich + classify per item.
    if (scrapeable.length) {
      const results = await scrapeBatch(
        scrapeable.map(it => ({ domain: it.domain, company_number: it.company_number }))
      )

      // 3b) PLAYWRIGHT FALLBACK (opt-in): domains Cheerio couldn't get (blocked,
      // errored, or loaded but had no contacts — often JS-rendered) get retried
      // with a real browser, which runs JS and passes most anti-bot walls.
      if (PLAYWRIGHT_FALLBACK) {
        const retry = scrapeable.filter(it => {
          const r = results.get(it.domain)
          return r && (r.status === 'blocked' || r.status === 'error' || r.status === 'no_contact')
        })
        if (retry.length) {
          log(`  job ${job.id}: Playwright fallback for ${retry.length} blocked/empty domain(s)`)
          try {
            const pwResults = await scrapeBatchPlaywright(
              retry.map(it => ({ domain: it.domain, company_number: it.company_number }))
            )
            // Keep the better result: prefer the one that actually found contacts.
            for (const it of retry) {
              const pw = pwResults.get(it.domain)
              const old = results.get(it.domain)
              if (pw && (pw.emails.length || pw.phones.length) && !(old.emails.length || old.phones.length)) {
                results.set(it.domain, pw)
              } else if (pw && pw.status === 'ok' && old.status !== 'ok') {
                results.set(it.domain, pw)
              }
            }
          } catch (err) {
            log(`  ! Playwright fallback failed: ${err.message}`)
          }
        }
      }

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
  await initProxies()
  log(`scraper-service ready — schema ensured, AI classifier=${classifierProvider}, polling for jobs`)

  // Recover jobs orphaned by a crash — but ONLY stale ones. The previous
  // unconditional `UPDATE ... WHERE status='running'` is fatal with replicas:
  // every booting worker would requeue jobs the OTHER workers were actively
  // running, so three replicas permanently sabotage each other and only one
  // ever makes progress. Heartbeats make the blanket reset unnecessary — a job
  // with a live heartbeat belongs to a live worker.
  const reclaimed = await reclaimStalledJobs(Number(process.env.JOB_STALE_SECS || 300))
  if (reclaimed) log(`↻ startup: reclaimed ${reclaimed} stale job(s)`)

  // Keep checking. Boot-time recovery only catches jobs orphaned BEFORE this
  // process started; a container killed mid-job (every deploy) can strand a job
  // claimed after that point, and nothing would ever reclaim it — the queue
  // silently stops with the dashboard still showing "running".
  const STALE_SECS = Number(process.env.JOB_STALE_SECS || 300)
  setInterval(async () => {
    try {
      const n = await reclaimStalledJobs(STALE_SECS)
      if (n) log(`↻ reclaimed ${n} stalled job(s) with no heartbeat for ${STALE_SECS}s`)
    } catch (err) { log('reclaim error:', err.message) }
  }, 60000).unref()

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
