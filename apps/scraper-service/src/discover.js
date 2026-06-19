import { nextProxyAgent } from './proxies.js'
import { normaliseDomain } from './extract.js'

// Strip common UK company-name suffixes/noise so we can slugify the trading name.
const SUFFIX_RE = /\b(limited|ltd|llp|plc|uk|holdings|group|services|company|co)\b/gi

function slug(name) {
  return String(name || '')
    .replace(SUFFIX_RE, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

// Candidate domains, most-likely first. UK businesses skew .co.uk.
function candidates(name) {
  const s = slug(name)
  if (!s || s.length < 3) return []
  return [`${s}.co.uk`, `${s}.com`, `${s}.uk`, `${s}.org.uk`]
}

const PARKED_RE = /(domain (is )?for sale|buy this domain|parked free|godaddy\.com\/domainsearch|sedoparking|this domain is parked)/i

async function isLive(domain) {
  const url = `https://${domain}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      dispatcher: nextProxyAgent(),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; OttalyBot/1.0)' },
    })
    if (!res.ok) return false
    const body = (await res.text()).slice(0, 4000)
    if (PARKED_RE.test(body)) return false
    return true
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

// Best-effort: returns a live domain guessed from the company name, or null.
export async function discoverDomain(companyName) {
  for (const c of candidates(companyName)) {
    if (await isLive(c)) return normaliseDomain(c)
  }
  return null
}
