// Shared extraction helpers — emails, UK phones, and likely person names.

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g
const PHONE_RE = /(?:\+44\s?|0)(?:\d\s?){9,10}/g
const EMAIL_NOISE = /\.(png|jpg|jpeg|gif|svg|css|webp)$/i
const PLACEHOLDER = /(example\.com|sentry|wixpress|\.png|\.jpg|domain\.com|yourname|email@)/i

export function extractEmails(text) {
  const found = [...new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()))]
  return found.filter(e => !EMAIL_NOISE.test(e) && !PLACEHOLDER.test(e) && e.length < 80)
}

export function extractPhones(text) {
  return [...new Set((text.match(PHONE_RE) || []).map(p => p.replace(/\s+/g, ' ').trim()))]
    .filter(p => p.replace(/\D/g, '').length >= 10)
}

// "Firstname Lastname" headings near team/about content. Best-effort.
export function extractNames($) {
  const names = []
  $('h2,h3,h4,p,span,div').each((_, el) => {
    const txt = $(el).text().trim()
    if (txt.length > 3 && txt.length < 50 && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(txt) && !/\d/.test(txt)) {
      names.push(txt)
    }
  })
  return [...new Set(names)].slice(0, 10)
}

// Contact-rich sub-pages we also visit per domain.
export const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team', '/people']

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
