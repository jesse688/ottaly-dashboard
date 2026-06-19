import { CheerioCrawler, ProxyConfiguration, log, LogLevel, Configuration } from 'crawlee'
import { proxyUrls } from './proxies.js'
import { extractEmails, extractPhones, extractNames, CONTACT_PATHS } from './extract.js'

log.setLevel(LogLevel.WARNING)

// Don't let Crawlee persist request queues / datasets to disk between runs —
// each batch is independent and the source of truth is Postgres.
Configuration.getGlobalConfig().set('persistStorage', false)

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
      emails: [], phones: [], names: [],
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
    navigationTimeoutSecs: 15,
    maxRequestRetries: 1,
    ignoreSslErrors: true,
    async requestHandler({ $, request }) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      if (!r) return
      const body = $('body').text()
      r.emails = [...new Set([...r.emails, ...extractEmails(body)])]
      r.phones = [...new Set([...r.phones, ...extractPhones(body)])]
      r.names = [...new Set([...r.names, ...extractNames($)])].slice(0, 10)
      if (!isSub) r.pageUrl = request.url
      if (r.status === 'pending') r.status = 'ok'
    },
    failedRequestHandler({ request }) {
      const { domain, isSub } = request.userData
      const r = results.get(domain)
      // Only the homepage failing should mark the whole domain as an error.
      if (r && !isSub && r.status === 'pending') {
        r.status = 'error'
        r.errorMsg = 'Homepage failed to load'
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
