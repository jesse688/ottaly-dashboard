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

  // A rotating set of realistic browser header sets. CheerioCrawler sends no
  // browser-like headers by default, so many sites 403 it instantly. We rotate
  // a recent Chrome/Firefox/Safari identity per request to look less like a bot.
  const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ]

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: opts.maxConcurrency ?? parseInt(process.env.MAX_CONCURRENCY || '50', 10),
    requestHandlerTimeoutSecs: 25,
    navigationTimeoutSecs: 20,
    // More retries + session rotation gives blocked requests a chance from a
    // fresh IP/identity before we give up on a domain.
    maxRequestRetries: 3,
    ignoreSslErrors: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 100 },
    // Send a full, realistic browser header set (rotated) on every request.
    preNavigationHooks: [
      async ({ request }, gotOptions) => {
        const ua = UA_POOL[Math.floor((request.retryCount || 0)) % UA_POOL.length] || UA_POOL[0]
        request.headers = {
          ...request.headers,
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        }
        if (gotOptions) { gotOptions.http2 = true; gotOptions.timeout = { request: 20000 } }
      },
    ],
    async requestHandler({ $, request }) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      if (!r) return
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
