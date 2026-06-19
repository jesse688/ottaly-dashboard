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

export function normaliseDomain(input) {
  return String(input || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
}
