import { ProxyAgent } from 'undici'

// PROXY_LIST: comma-separated host:port:user:pass entries.
const RAW = (process.env.PROXY_LIST || '').split(',').map(s => s.trim()).filter(Boolean)

function toUrl(entry) {
  const [host, port, user, pass] = entry.split(':')
  if (!host || !port) return null
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : ''
  return `http://${auth}${host}:${port}`
}

// Crawlee wants an array of proxy URLs; it rotates them itself.
export const proxyUrls = RAW.map(toUrl).filter(Boolean)

// For discovery (plain fetch) we hand out undici dispatchers round-robin.
const agents = proxyUrls.map(uri => new ProxyAgent({ uri, requestTls: { rejectUnauthorized: false } }))
let i = 0
export function nextProxyAgent() {
  if (agents.length === 0) return undefined
  const a = agents[i % agents.length]
  i += 1
  return a
}
