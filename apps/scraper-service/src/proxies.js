import { ProxyAgent } from 'undici'

// Proxies come from EITHER:
//   PROXY_LIST     — comma-separated host:port:user:pass entries, OR
//   PROXY_LIST_URL — a URL (e.g. Webshare's download link) returning the list
//                    as newline-separated host:port:user:pass lines.
// PROXY_LIST_URL is preferred for rotating providers — set it once and the list
// stays current. initProxies() must be awaited at worker startup before crawling.

function toUrl(entry) {
  const parts = entry.trim().split(':')
  const [host, port, user, pass] = parts
  if (!host || !port) return null
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : ''
  return `http://${auth}${host}:${port}`
}

function parseList(text) {
  // Accept commas OR newlines as separators.
  return text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(toUrl).filter(Boolean)
}

// Mutable so initProxies() can populate it after an async fetch.
export let proxyUrls = parseList(process.env.PROXY_LIST || '')

let agents = []
let i = 0
function buildAgents() {
  agents = proxyUrls.map(uri => new ProxyAgent({ uri, requestTls: { rejectUnauthorized: false } }))
}
buildAgents()

// Fetch the proxy list from PROXY_LIST_URL if set (overrides PROXY_LIST). Safe to
// call once at startup; logs how many proxies loaded so it's obvious in the logs.
export async function initProxies() {
  const url = process.env.PROXY_LIST_URL
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const fromUrl = parseList(text)
      if (fromUrl.length) {
        proxyUrls = fromUrl
        buildAgents()
      }
      console.log(`[proxies] loaded ${proxyUrls.length} prox, from PROXY_LIST_URL`)
    } catch (err) {
      console.error(`[proxies] PROXY_LIST_URL fetch failed (${err.message}) — falling back to PROXY_LIST (${proxyUrls.length})`)
    }
  } else {
    console.log(`[proxies] ${proxyUrls.length} proxy(ies) from PROXY_LIST${proxyUrls.length ? '' : ' — NONE set, crawling direct'}`)
  }
  return proxyUrls
}

// For discovery (plain fetch) we hand out undici dispatchers round-robin.
export function nextProxyAgent() {
  if (agents.length === 0) return undefined
  const a = agents[i % agents.length]
  i += 1
  return a
}
