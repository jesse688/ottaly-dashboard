import { CheerioCrawler, PlaywrightCrawler, ProxyConfiguration, log, LogLevel, Configuration } from 'crawlee'
import * as cheerio from 'cheerio'
import { proxyUrls } from './proxies.js'
import {
  extractEmails, extractPhones, extractNames, CONTACT_PATHS,
  extractSocials, extractMetaDescription, extractMetaKeywords,
  extractJsonLd, extractAddressHeuristic, pageTextSample,
} from './extract.js'

log.setLevel(LogLevel.WARNING)

// Don't let Crawlee persist request queues / datasets to disk between runs —
// each batch is independent and the source of truth is Postgres.
Configuration.getGlobalConfig().set('persistStorage', false)

// Shared per-page extraction — used by BOTH the Cheerio and Playwright crawlers
// so they produce identical results. Takes a cheerio $ (Playwright loads its
// rendered HTML into cheerio first), the result accumulator, whether it's a
// sub-page, and the page URL.
function applyExtraction($, r, isSub, url) {
  if (typeof $ !== 'function') { if (r.status === 'pending') r.status = 'ok'; return }
  // Join text nodes with a space rather than $('body').text(), which
  // concatenates them with nothing between: `<a>info@acme.co.uk</a>media`
  // collapses to "info@acme.co.ukmedia" and the email regex swallows the
  // trailing word. See cheeriojs/cheerio#1306.
  const body = $('body').find('*').contents()
    .map((_, el) => (el.type === 'text' ? $(el).text() : ''))
    .get().join(' ')
  r.emails = [...new Set([...r.emails, ...extractEmails(body)])]
  r.phones = [...new Set([...r.phones, ...extractPhones(body)])]
  r.names = [...new Set([...r.names, ...extractNames($)])].slice(0, 10)
  r.socials = { ...extractSocials($), ...r.socials }
  r.metaKeywords = [...new Set([...r.metaKeywords, ...extractMetaKeywords($)])].slice(0, 25)
  const jsonld = extractJsonLd($)
  if (!r.address) r.address = jsonld.address || extractAddressHeuristic($)
  if (!r.jsonldType && jsonld.type) r.jsonldType = jsonld.type
  if (!isSub) {
    r.pageUrl = url
    r.description = extractMetaDescription($) || r.description
    r.textSample = pageTextSample($)
  } else if (!r.description) {
    r.description = extractMetaDescription($)
  }
  if (r.status === 'pending') r.status = 'ok'
}

// Build the empty per-domain result accumulator + start URLs (homepage + contact
// paths). Shared so Cheerio and Playwright batches start from the same shape.
function buildTargets(targets) {
  const results = new Map()
  const startUrls = []
  for (const t of targets) {
    results.set(t.domain, {
      domain: t.domain, company_number: t.company_number ?? null,
      pageUrl: `https://${t.domain}`, website: `https://${t.domain}`,
      emails: [], phones: [], names: [], socials: {}, metaKeywords: [],
      description: null, address: null, jsonldType: null, textSample: null,
      status: 'pending', errorMsg: null,
    })
    const base = `https://${t.domain}`
    startUrls.push({ url: base, userData: { domain: t.domain, isSub: false } })
    for (const p of CONTACT_PATHS) startUrls.push({ url: base + p, userData: { domain: t.domain, isSub: true } })
  }
  return { results, startUrls }
}

function finaliseStatuses(results) {
  for (const r of results.values()) {
    if (r.status === 'ok' && r.emails.length === 0 && r.phones.length === 0) r.status = 'no_contact'
    if (r.status === 'pending') { r.status = 'error'; r.errorMsg = r.errorMsg || 'No response' }
  }
}

/**
 * Playwright (real browser) fallback for domains Cheerio couldn't get — runs JS,
 * passes most anti-bot challenges. Heavier: needs Chromium + RAM. Same result
 * shape as scrapeBatch. Only call this for the blocked/empty domains.
 */
export async function scrapeBatchPlaywright(targets, opts = {}) {
  const { results, startUrls } = buildTargets(targets)
  const proxyConfiguration = proxyUrls.length > 0 ? new ProxyConfiguration({ proxyUrls }) : undefined
  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: opts.maxConcurrency ?? parseInt(process.env.PLAYWRIGHT_CONCURRENCY || '2', 10),
    requestHandlerTimeoutSecs: 45,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
    headless: true,
    async requestHandler({ page, request }) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      if (!r) return
      try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }) } catch { /* best effort */ }
      const html = await page.content()
      applyExtraction(cheerio.load(html), r, isSub, request.url)
    },
    failedRequestHandler({ request }, error) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      if (r && !isSub && r.status === 'pending') {
        r.status = 'error'
        r.errorMsg = `Playwright failed: ${(error?.message || '').slice(0, 80)}`
      }
    },
  })
  await crawler.run(startUrls)
  finaliseStatuses(results)
  return results
}

// Crawlee's memory snapshot needs `ps` (provided by procps in the Docker image;
// index.js probes for it at startup). Keep the autoscaler modest on a small
// container so a 1000-item job doesn't try to fan out beyond what the box / the
// proxy pool can handle.
Configuration.getGlobalConfig().set('availableMemoryRatio', 0.5)

/**
 * Scrape a batch of domains for emails / phones / names.
 * @param {{domain:string, company_number?:string}[]} targets
 * @param {{maxConcurrency?:number}} opts
 * @returns {Promise<Map<string, {domain,company_number,pageUrl,emails,phones,names,status,errorMsg}>>}
 */
export async function scrapeBatch(targets, opts = {}) {
  const results = new Map()
  for (const t of targets) {
    results.set(t.domain, {
      domain: t.domain,
      company_number: t.company_number ?? null,
      pageUrl: `https://${t.domain}`,
      website: `https://${t.domain}`,
      emails: [], phones: [], names: [],
      socials: {}, metaKeywords: [],
      description: null, address: null, jsonldType: null, textSample: null,
      status: 'pending', errorMsg: null,
    })
  }

  const startUrls = []
  for (const t of targets) {
    const base = `https://${t.domain}`
    startUrls.push({ url: base, userData: { domain: t.domain, isSub: false } })
    for (const p of CONTACT_PATHS) {
      startUrls.push({ url: base + p, userData: { domain: t.domain, isSub: true } })
    }
  }

  const proxyConfiguration = proxyUrls.length > 0 ? new ProxyConfiguration({ proxyUrls }) : undefined

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    // Default low: a small free proxy pool (e.g. 10 shared IPs) gets overloaded
    // and returns 502s under high concurrency. ~5 is safe for 10 proxies; raise
    // MAX_CONCURRENCY once you have a larger/paid pool.
    maxConcurrency: opts.maxConcurrency ?? parseInt(process.env.MAX_CONCURRENCY || '5', 10),
    // maxConcurrency is only a CEILING. Crawlee's autoscaled pool starts at
    // minConcurrency (default 1) and ramps on observed system load — but these
    // requests are almost pure network wait, so CPU/memory never signal "go
    // faster" and it settles far below the ceiling. Measured: 100 domains x 3
    // pages took ~5 minutes, i.e. ~1 request/sec against a ceiling of 50.
    // Setting minConcurrency floors it so a batch runs at a useful rate from the
    // first request instead of spending the batch ramping.
    minConcurrency: Number(process.env.MIN_CONCURRENCY || 15),
    // Guard rail so the floor can't hammer one host or burn the proxy plan's
    // bandwidth faster than intended.
    maxRequestsPerMinute: Number(process.env.MAX_RPM || 1200),
    // Tuned for a FAST FIRST PASS. ~34% of matched domains are dead (lapsed
    // registrations in the Common Crawl set) and each one costs the full timeout
    // on every page and every retry. A live small-business site answers well
    // inside 8s; slower is overwhelmingly a domain that never will.
    //
    // This deliberately trades a little recall for a lot of speed: anything that
    // times out lands in scraped_contacts with status='error' and can be
    // re-run later with generous settings (NAV_TIMEOUT_SECS=25 MAX_RETRIES=3),
    // by which point the retry set is thousands of domains rather than 800k.
    requestHandlerTimeoutSecs: Number(process.env.REQ_TIMEOUT_SECS || 10),
    navigationTimeoutSecs: Number(process.env.NAV_TIMEOUT_SECS || 6),
    // Some (mis-configured) servers label their HTML as octet-stream / plain text.
    // Accept those too so we still parse the page instead of skipping the domain.
    additionalMimeTypes: ['application/octet-stream', 'text/plain', 'application/x-download'],
    // Retries exist for blocked requests, which a fresh session can fix. They do
    // nothing for a domain with no DNS or no server, and that is the common case
    // here — so 3 retries multiplied the dead-domain cost 4x for no extra yield.
    maxRequestRetries: Number(process.env.MAX_RETRIES || 1),
    maxSessionRotations: 2,
    ignoreSslErrors: true,
    // Session pool retires blocked/error sessions and rotates IP+identity.
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 100 },
    // The Crawlee-correct way to look like a real browser: CheerioCrawler uses
    // got-scraping, whose HeaderGenerator is ON by default and produces a full,
    // consistent, realistic header set (UA + sec-ch-ua + accept-language…). We
    // do NOT hand-roll/override headers (that defeats the generator). We only
    // STEER it toward modern desktop browsers via gotOptions.headerGeneratorOptions
    // (it's a per-request option, not a crawler-level one), and enable http2.
    preNavigationHooks: [
      async (_ctx, gotOptions) => {
        gotOptions.http2 = true
        gotOptions.headerGeneratorOptions = {
          browsers: [{ name: 'chrome', minVersion: 110 }, { name: 'firefox', minVersion: 110 }],
          devices: ['desktop'],
          operatingSystems: ['windows', 'macos'],
          locales: ['en-GB', 'en-US'],
        }
      },
    ],
    async requestHandler({ $, request }) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      if (!r) return
      // For non-HTML bodies we accepted via additionalMimeTypes (octet-stream,
      // plain text), Crawlee doesn't build a Cheerio object — `$` is undefined.
      // Mark the page reached but skip extraction rather than crash.
      if (typeof $ !== 'function') {
        if (r.status === 'pending') r.status = 'ok'
        return
      }
      applyExtraction($, r, isSub, request.url)
    },
    failedRequestHandler({ request }, error) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      // Only the homepage failing should mark the whole domain as an error.
      if (r && !isSub && r.status === 'pending') {
        const blocked = /403|blocked|forbidden/i.test(error?.message || '')
        r.status = blocked ? 'blocked' : 'error'
        r.errorMsg = blocked ? 'Blocked (403) — site has anti-bot protection' : 'Homepage failed to load'
      }
    },
  })

  await crawler.run(startUrls)

  // Finalise statuses: a domain that loaded but had nothing is "no_contact".
  for (const r of results.values()) {
    if (r.status === 'ok' && r.emails.length === 0 && r.phones.length === 0) {
      r.status = 'no_contact'
    }
    if (r.status === 'pending') {
      r.status = 'error'
      r.errorMsg = r.errorMsg || 'No response'
    }
  }
  return results
}
