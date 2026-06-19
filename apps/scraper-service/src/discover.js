import { promises as dns } from 'node:dns'
import { nextProxyAgent } from './proxies.js'
import { normaliseDomain } from './extract.js'

// Website discovery, in order of confidence (each step only runs if the previous
// found nothing): 1) guess from the name, 2) SearXNG web search, 3) Gemini.
// Ported from admin-legacy's CH pipeline so coverage matches what the dashboard
// already achieves. All external services are read from env and optional —
// discovery degrades gracefully to whatever is configured.

const SEARXNG_URL = (process.env.SEARXNG_URL || '').replace(/\/$/, '')
const SEARXNG_ENGINES = process.env.SEARXNG_ENGINES || 'mojeek,bing'
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-1.5-flash'].filter(Boolean)

// ── 1) Name-guess ────────────────────────────────────────────────────────────
const SUFFIX_RE = /\b(limited|ltd|llp|plc|uk|holdings|group|services|company|co)\b/gi
function slug(name) {
  return String(name || '')
    .replace(SUFFIX_RE, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9 ]/gi, ' ')
    .trim().toLowerCase().replace(/\s+/g, '')
}
function candidates(name) {
  const s = slug(name)
  if (!s || s.length < 3) return []
  return [`${s}.co.uk`, `${s}.com`, `${s}.uk`, `${s}.org.uk`]
}

// ── Shared helpers ───────────────────────────────────────────────────────────
const PARKED_RE = /(domain (is )?for sale|buy this domain|parked free|godaddy\.com\/domainsearch|sedoparking|this domain is parked)/i

async function isLive(domain) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'GET', redirect: 'follow', signal: ctrl.signal,
      dispatcher: nextProxyAgent(),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    })
    if (!res.ok) return false
    const body = (await res.text()).slice(0, 4000)
    return !PARKED_RE.test(body)
  } catch { return false } finally { clearTimeout(t) }
}

// Trust a domain only if DNS resolves (rejects Gemini hallucinations).
async function domainResolves(domain) {
  for (const fn of [() => dns.resolveMx(domain), () => dns.resolve4(domain), () => dns.resolve(domain)]) {
    try { const r = await fn(); if (r && r.length) return true } catch { /* try next */ }
  }
  return false
}

// ── 2) SearXNG web search ────────────────────────────────────────────────────
const STOP = new Set(['ltd','limited','plc','llp','the','and','uk','group','company','co','services','holdings','international'])
function nameTokens(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))
}
function rootDomain(host) {
  const h = (host || '').toLowerCase().replace(/^www\./, '')
  const labels = h.split('.')
  if (/\.(co|org|ltd|plc|me|gov|ac|net)\.uk$/.test(h)) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}
const NON_COMPANY = new Set([
  'companieshouse.gov.uk','find-and-update.company-information.service.gov.uk','gov.uk','endole.co.uk',
  'dnb.com','opencorporates.com','companycheck.co.uk','companieslist.co.uk','creditsafe.com','globaldatabase.com',
  'bizdb.co.uk','linkedin.com','facebook.com','twitter.com','x.com','instagram.com','youtube.com','tiktok.com',
  'pinterest.com','yell.com','yelp.com','trustpilot.com','tripadvisor.com','tripadvisor.co.uk','glassdoor.com',
  'indeed.com','crunchbase.com','bloomberg.com','reuters.com','wikipedia.org','wikipedia.com','amazon.co.uk','amazon.com',
  'ebay.co.uk','booking.com','dailymail.co.uk','companiesintheuk.co.uk','ukbusinessforums.co.uk',
  'reddit.com','medium.com','github.com','gov.scot','nhs.uk','google.com','bing.com','apple.com','microsoft.com',
])

// Minimum score a candidate must reach before we trust it as the company's site.
// Stops weak coincidental matches (e.g. a "101…" company matching spiele101.de
// on a single numeric token) from being accepted.
const MIN_SCORE = 4

async function searxLookup(name) {
  if (!SEARXNG_URL || !name) return null
  const tokens = nameTokens(name)
  const compact = tokens.join('')
  for (const engine of SEARXNG_ENGINES.split(',').map(e => e.trim()).filter(Boolean)) {
    try {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(name)}&format=json&engines=${encodeURIComponent(engine)}`
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      const j = await r.json()
      const results = Array.isArray(j?.results) ? j.results : []
      if (!results.length) continue
      const scored = [], seen = new Set()
      for (let i = 0; i < results.length; i++) {
        let host
        try { host = new URL(results[i].url).hostname.toLowerCase().replace(/^www\./, '') } catch { continue }
        const root = rootDomain(host)
        if (NON_COMPANY.has(root) || NON_COMPANY.has(host) || seen.has(root)) continue
        seen.add(root)
        const domainText = root.replace(/\.[a-z.]+$/, '')
        let score = 0
        let alphaMatch = false
        for (const t of tokens) {
          if (!domainText.includes(t)) continue
          // Pure-numeric or very short tokens (e.g. "101") match too easily and
          // produce wrong domains — score them low and don't let them qualify alone.
          if (/^\d+$/.test(t) || t.length <= 3) { score += 0.5 }
          else { score += 3; alphaMatch = true }
        }
        if (compact && compact.length >= 5 && domainText.includes(compact)) { score += 4; alphaMatch = true }
        score += Math.max(0, 5 - i) * 0.5
        if (/\.co\.uk$/.test(root) || /\.uk$/.test(root)) score += 1
        // Require a real (alphabetic) name match, not just a stray number/rank bonus.
        if (score >= MIN_SCORE && alphaMatch) scored.push({ root, score, rank: i })
      }
      if (!scored.length) continue
      scored.sort((a, b) => b.score - a.score || a.rank - b.rank)
      return scored[0].root
    } catch { continue }
  }
  return null
}

// ── 3) Gemini fallback ───────────────────────────────────────────────────────
function extractJson(text) {
  if (!text) return null
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s === -1 || e === -1) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}
async function geminiLookup(name) {
  if (!GEMINI_KEY || !name) return null
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: `What is the website domain (no protocol, no www) for the UK company "${name}"? Return null if you don't know it.` }] }],
    generationConfig: {
      maxOutputTokens: 2048, temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { website: { type: 'STRING', nullable: true } }, required: ['website'] },
    },
  })
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) })
      if (!r.ok) { if (r.status === 404) continue; return null }
      const j = await r.json()
      const parsed = extractJson(j?.candidates?.[0]?.content?.parts?.[0]?.text || '')
      const raw = (parsed?.website || '').replace(/^https?:\/\//i, '').replace(/\/.*/, '').replace(/^www\./i, '').trim().toLowerCase()
      if (!raw) return null
      // Reject hallucinated domains — only trust ones with real DNS.
      return (await domainResolves(raw)) ? raw : null
    } catch { continue }
  }
  return null
}

/**
 * Find a live website for a company name. Tries name-guess, then SearXNG search,
 * then Gemini — returning the first that passes a liveness/DNS check, or null.
 */
export async function discoverDomain(companyName) {
  // 1) Cheap name-guess + liveness probe.
  for (const c of candidates(companyName)) {
    if (await isLive(c)) return normaliseDomain(c)
  }
  // 2) SearXNG web search (verify it's actually live before trusting it).
  const fromSearx = await searxLookup(companyName)
  if (fromSearx && await isLive(fromSearx)) return normaliseDomain(fromSearx)
  // 3) Gemini (already DNS-checked inside; liveness-confirm too).
  const fromGemini = await geminiLookup(companyName)
  if (fromGemini && await isLive(fromGemini)) return normaliseDomain(fromGemini)
  return null
}
