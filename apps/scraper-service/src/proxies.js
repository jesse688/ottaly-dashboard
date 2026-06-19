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

// Fetch proxies from Webshare's API (preferred — the API token does NOT expire
// like the download-link token). Returns host:port:user:pass entries or [].
async function fetchWebshareApi(apiKey) {
  const out = []
  let url = 'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100'
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Token ${apiKey}` }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`Webshare API HTTP ${res.status}`)
    const j = await res.json()
    for (const p of (j.results || [])) {
      if (p.proxy_address && p.port) {
        out.push(`${p.proxy_address}:${p.port}:${p.username || ''}:${p.password || ''}`)
      }
    }
    url = j.next || null
  }
  return parseList(out.join('\n'))
}

// Load proxies, in order of preference:
//   WEBSHARE_API_KEY  → Webshare API (token never expires) [recommended]
//   PROXY_LIST_URL    → a download URL (note: Webshare download tokens expire)
//   PROXY_LIST        → manual comma-separated list
// Safe to call once at startup; logs how many loaded so it's obvious in the logs.
export async function initProxies() {
  const apiKey = process.env.WEBSHARE_API_KEY
  const url = process.env.PROXY_LIST_URL
  try {
    if (apiKey) {
      const fromApi = await fetchWebshareApi(apiKey)
      if (fromApi.length) { proxyUrls = fromApi; buildAgents() }
      console.log(`[proxies] loaded ${proxyUrls.length} from Webshare API`)
    } else if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      // Webshare returns JSON on a bad download token — detect & warn clearly.
      if (text.trim().startsWith('{')) throw new Error('URL returned JSON, not a proxy list (download token invalid/expired?)')
      const fromUrl = parseList(text)
      if (fromUrl.length) { proxyUrls = fromUrl; buildAgents() }
      console.log(`[proxies] loaded ${proxyUrls.length} from PROXY_LIST_URL`)
    } else {
      console.log(`[proxies] ${proxyUrls.length} from PROXY_LIST${proxyUrls.length ? '' : ' — NONE set, crawling direct'}`)
    }
  } catch (err) {
    console.error(`[proxies] load failed (${err.message}) — using PROXY_LIST fallback (${proxyUrls.length})`)
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
