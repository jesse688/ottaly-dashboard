// Shared extraction helpers — emails, UK phones, and likely person names.

// {2,24} bounds the TLD. Unbounded {2,} lets a match run past a real TLD into
// whatever follows when markup is stripped without a separator, producing
// "enquiries@smithsnews.co.ukmedia". 24 covers the longest real TLDs
// (.travelersinsurance) while still cutting off glued-on prose.
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}\b/g
const PHONE_RE = /(?:\+44\s?|0)(?:\d\s?){9,10}/g
const EMAIL_NOISE = /\.(png|jpg|jpeg|gif|svg|css|webp)$/i
const PLACEHOLDER = /(example\.com|sentry|wixpress|\.png|\.jpg|domain\.com|yourname|email@)/i

// Multi-part UK suffixes are listed first: alternation is ordered, so without
// "co.uk" ahead of "uk" a trim would cut "acme.co.uk" back to "acme.co".
const KNOWN_TLD = /\.(co\.uk|org\.uk|ltd\.uk|plc\.uk|me\.uk|sch\.uk|ac\.uk|gov\.uk|nhs\.uk|net\.uk|com|org|net|uk|io|ai|dev|app|eu|ie|de|fr|es|it|nl|be|us|ca|au|nz|info|biz|online|shop|store|agency|company|group|london|scot|wales|cymru|email|life|live|world|today|team|care|health|clinic|dental|legal|finance|solutions|services|consulting|design|studio|media|digital|tech|systems|works|energy|solar|homes|properties|estate|travel|coop|charity|church|academy|school|college|education|training|events|photography|fitness|gallery)$/i

/**
 * Trim a match back to a known TLD boundary: "info@acme.co.ukmedia" ->
 * "info@acme.co.uk". Returns null when no known TLD is found, dropping the
 * value rather than guessing where to cut — a wrong address costs a
 * verification credit and a bounce.
 */
function trimToKnownTld(email) {
  if (KNOWN_TLD.test(email)) return email
  const at = email.lastIndexOf('@')
  if (at < 1) return null
  const local = email.slice(0, at)
  const host = email.slice(at + 1)
  for (let end = host.length - 1; end > 3; end--) {
    const cand = host.slice(0, end)
    if (KNOWN_TLD.test(cand)) return `${local}@${cand}`
  }
  return null
}

export function extractEmails(text) {
  const found = [...new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()))]
  return found
    .map(trimToKnownTld)
    .filter(Boolean)
    .filter(e => !EMAIL_NOISE.test(e) && !PLACEHOLDER.test(e) && e.length < 80)
    .filter((e, i, a) => a.indexOf(e) === i)   // trimming can create duplicates
}

export function extractPhones(text) {
  return [...new Set((text.match(PHONE_RE) || []).map(p => p.replace(/\s+/g, ' ').trim()))]
    .filter(p => p.replace(/\D/g, '').length >= 10)
}

// "Firstname Lastname" headings near team/about content. Best-effort.
// UI text that matches "Two Capitalised Words" but is never a person. Without
// this the extractor returns "Page Not Found", "Log In", "First Name" — which is
// what it did across the first million domains, making raw_names unusable.
const NOT_A_NAME = /^(page not found|log ?in|sign ?in|sign ?up|first name|last name|full name|user name|email address|phone number|contact us|about us|read more|learn more|find out|get in|our team|meet the|privacy policy|terms and|cookie policy|all rights|company number|registered office|opening hours|customer service|free delivery|add to|view all|show more|main menu|skip to|search results|home page|news events|case studies|why choose|what we|how we|our services|our products|our clients|our work|latest news|book now|get started|contact form|thank you|coming soon|under construction)/i

// Job titles worth knowing for outreach — seniority is the usual ICP filter.
const TITLE_RE = /\b(chief executive|managing director|finance director|operations director|sales director|marketing director|technical director|creative director|founder|co-?founder|owner|proprietor|partner|principal|president|chairman|chairwoman|director|head of [a-z ]{3,25}|general manager|practice manager|office manager|operations manager|sales manager|marketing manager|account manager|business development|ceo|cfo|coo|cto|cmo|md)\b/i

/**
 * People named on the page, with a job title where one sits nearby.
 *
 * The old version matched any two capitalised words in any element, which is why
 * raw_names filled with navigation text. This requires a plausible name shape,
 * rejects known UI strings, and prefers elements on team/about pages where a
 * title appears in the same block — a name with a title is worth far more for
 * targeting than a bare name.
 */
export function extractNames($) {
  const out = []
  const seen = new Set()
  // Narrower element set: names appear in headings and short blocks, not in
  // every div on the page.
  $('h2,h3,h4,h5,strong,b,figcaption,li,td').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim()
    if (txt.length < 5 || txt.length > 60) return
    if (NOT_A_NAME.test(txt)) return
    // "Firstname Lastname", optionally with a middle initial or double-barrel.
    const m = txt.match(/^([A-Z][a-z]{1,15}(?:-[A-Z][a-z]{1,15})?)\s+(?:[A-Z]\.?\s+)?([A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})?)$/)
    if (!m) return
    const name = `${m[1]} ${m[2]}`
    if (seen.has(name)) return
    // A title in the same element or the next one turns a name into a lead.
    const near = (txt + ' ' + $(el).next().text() + ' ' + $(el).parent().text()).slice(0, 400)
    const t = near.match(TITLE_RE)
    seen.add(name)
    out.push(t ? `${name} — ${t[0]}` : name)
  })
  // Titled entries first: they're the ones worth writing to.
  out.sort((a, b) => (b.includes('—') ? 1 : 0) - (a.includes('—') ? 1 : 0))
  return out.slice(0, 12)
}

// ─── ICP signals ─────────────────────────────────────────────────────────────
// Attributes a marketing team can actually segment on. Everything here comes
// from HTML already fetched, so it costs no extra requests.

const PLATFORMS = [
  ['shopify', /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme/i],
  ['woocommerce', /woocommerce|wp-content\/plugins\/woocommerce/i],
  ['magento', /\/static\/version\d|Magento_|mage\/cookies/i],
  ['bigcommerce', /bigcommerce|cdn\d*\.bigcommerce/i],
  ['prestashop', /prestashop/i],
  ['squarespace', /squarespace|static1\.squarespace/i],
  ['wix', /\.wix\.com|wixstatic\.com/i],
  ['webflow', /webflow\.(com|io)|wf-form/i],
  ['wordpress', /wp-content|wp-includes/i],
  ['hubspot', /hs-scripts\.com|hubspot/i],
  ['salesforce', /salesforce|pardot/i],
]
const ECOM_PLATFORMS = new Set(['shopify', 'woocommerce', 'magento', 'bigcommerce', 'prestashop'])

/**
 * @returns {{platform:string|null, tech:string[], ecommerce:boolean,
 *            team_size:number|null, has_careers:boolean, multi_location:boolean}}
 */
export function extractIcpSignals($, html) {
  const tech = []
  let platform = null
  for (const [name, re] of PLATFORMS) {
    if (re.test(html)) { tech.push(name); if (!platform) platform = name }
  }

  // Ecommerce: a store platform, Product schema, or a basket link. Any one is
  // enough — plenty of shops run on a generic CMS.
  const ecommerce = (platform && ECOM_PLATFORMS.has(platform))
    || /"@type"\s*:\s*"Product"|itemtype="[^"]*schema\.org\/Product"/i.test(html)
    || $('a[href*="/cart"], a[href*="/basket"], a[href*="/checkout"]').length > 0

  // Headcount proxy: distinct people named on a team page. Crude, but it
  // separates a sole trader from a 30-person firm, which is the split that
  // usually matters for ICP.
  const names = extractNames($)
  const team_size = names.length >= 3 ? names.length : null

  const has_careers = $('a[href*="career"], a[href*="jobs"], a[href*="vacanc"], a[href*="recruit"]').length > 0
  // Several branch/location links suggests a multi-site operation.
  const multi_location = $('a[href*="location"], a[href*="branch"], a[href*="/our-offices"]').length >= 2

  return { platform, tech, ecommerce, team_size, has_careers, multi_location }
}

// Contact-rich sub-pages we also visit per domain.
// Trimmed from 7 paths to 2. Every extra path is a request against EVERY domain
// including the ~34% that are dead, where each one burns the full navigation
// timeout before failing. Measured on a 500-domain sample: homepage + /contact +
// /about finds essentially the same emails as the full 8-page crawl, because
// sites that publish an address put it in the header, footer, or contact page.
// Set CONTACT_PATHS_FULL=1 to restore the wide crawl for a specific job.
export const CONTACT_PATHS = process.env.CONTACT_PATHS_FULL === '1'
  ? ['/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team', '/people']
  : ['/contact', '/about']

const SOCIAL_HOSTS = {
  linkedin: /linkedin\.com\//i,
  facebook: /facebook\.com\//i,
  twitter: /(twitter\.com|x\.com)\//i,
  instagram: /instagram\.com\//i,
  youtube: /youtube\.com\//i,
}

export function extractSocials($) {
  const out = {}
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    for (const [name, re] of Object.entries(SOCIAL_HOSTS)) {
      if (!out[name] && re.test(href) && !/\/(sharer|share|intent)/i.test(href)) {
        out[name] = href.split('?')[0]
      }
    }
  })
  return out
}

export function extractMetaDescription($) {
  const d =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  return d.trim().slice(0, 500) || null
}

export function extractMetaKeywords($) {
  const k = $('meta[name="keywords"]').attr('content') || ''
  return k.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25)
}

// Parse schema.org JSON-LD for an Organization / LocalBusiness block.
export function extractJsonLd($) {
  const result = { type: null, address: null }
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text()
    if (!raw) return
    let data
    try { data = JSON.parse(raw) } catch { return }
    const nodes = Array.isArray(data) ? data : data['@graph'] || [data]
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const t = node['@type']
      const typeStr = Array.isArray(t) ? t.join(', ') : t
      if (typeStr && /Organization|LocalBusiness|Corporation|Store|Service/i.test(typeStr)) {
        if (!result.type) result.type = typeStr
        const a = node.address
        if (a && typeof a === 'object' && !result.address) {
          result.address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
            .filter(Boolean).join(', ') || null
        }
      }
    }
  })
  return result
}

const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i

// Fallback address: a footer/contact line containing a UK postcode.
export function extractAddressHeuristic($) {
  let best = null
  $('footer, address, .address, #footer').each((_, el) => {
    if (best) return
    const txt = $(el).text().replace(/\s+/g, ' ').trim()
    if (UK_POSTCODE.test(txt) && txt.length < 200) best = txt
  })
  return best
}

// Compact, classifier-friendly sample of the page (title + desc + headings + lead text).
export function pageTextSample($) {
  const title = $('title').first().text().trim()
  const desc = extractMetaDescription($) || ''
  const headings = []
  $('h1,h2,h3').each((_, el) => {
    const t = $(el).text().trim()
    if (t) headings.push(t)
  })
  const body = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 1500)
  return [
    title && `Title: ${title}`,
    desc && `Description: ${desc}`,
    headings.length && `Headings: ${headings.slice(0, 15).join(' | ')}`,
    `Body: ${body}`,
  ].filter(Boolean).join('\n')
}

export function normaliseDomain(input) {
  return String(input || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
}
