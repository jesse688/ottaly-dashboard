import { CheerioCrawler, ProxyConfiguration, log, LogLevel, Configuration } from 'crawlee'
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
    maxConcurrency: opts.maxConcurrency ?? parseInt(process.env.MAX_CONCURRENCY || '50', 10),
    requestHandlerTimeoutSecs: 25,
    navigationTimeoutSecs: 20,
    // Some (mis-configured) servers label their HTML as octet-stream / plain text.
    // Accept those too so we still parse the page instead of skipping the domain.
    additionalMimeTypes: ['application/octet-stream', 'text/plain', 'application/x-download'],
    // More retries + session rotation gives blocked requests a chance from a
    // fresh IP/identity before we give up on a domain. Cap session rotations so
    // a dead proxy / 502-ing site doesn't retry ~10x (was flooding the log).
    maxRequestRetries: 3,
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
      const body = $('body').text()
      r.emails = [...new Set([...r.emails, ...extractEmails(body)])]
      r.phones = [...new Set([...r.phones, ...extractPhones(body)])]
      r.names = [...new Set([...r.names, ...extractNames($)])].slice(0, 10)
      r.socials = { ...extractSocials($), ...r.socials } // earlier (homepage) wins
      r.metaKeywords = [...new Set([...r.metaKeywords, ...extractMetaKeywords($)])].slice(0, 25)

      const jsonld = extractJsonLd($)
      if (!r.address) r.address = jsonld.address || extractAddressHeuristic($)
      if (!r.jsonldType && jsonld.type) r.jsonldType = jsonld.type

      // Prefer the homepage for description + the classifier text sample.
      if (!isSub) {
        r.pageUrl = request.url
        r.description = extractMetaDescription($) || r.description
        r.textSample = pageTextSample($)
      } else if (!r.description) {
        r.description = extractMetaDescription($)
      }
      if (r.status === 'pending') r.status = 'ok'
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
