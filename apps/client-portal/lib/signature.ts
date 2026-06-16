// Extract contact details from an email signature / body.
//
// The prospect's own latest email is the freshest source of truth — newer than
// the Apollo/ESP enrichment captured when the lead was first created. So when a
// configured field is found in their email, we OVERRIDE the stored value.
//
// Which fields are scanned is controlled by admin settings (see app_settings
// key 'signature_extract_fields'). Each field maps to the esp_leads.raw JSONB
// key the sidebar already reads, so a successful extraction shows up with no
// extra display wiring.

export type SignatureField = 'phone_number' | 'company_website' | 'linkedin_person_url' | 'linkedin_company_url' | 'job_title' | 'company_name'

export const SIGNATURE_FIELD_LABELS: Record<SignatureField, string> = {
  phone_number: 'Phone / mobile',
  company_website: 'Website',
  linkedin_person_url: 'LinkedIn (person)',
  linkedin_company_url: 'LinkedIn (company)',
  job_title: 'Job title',
  company_name: 'Company',
}

export const ALL_SIGNATURE_FIELDS: SignatureField[] = [
  'phone_number', 'company_website', 'linkedin_person_url', 'linkedin_company_url', 'job_title', 'company_name',
]

// Common job titles — used to spot a title line in a signature. Kept broad but
// anchored so we don't grab arbitrary text.
const TITLE_WORDS = [
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'Founder', 'Co-Founder', 'Owner', 'Partner',
  'Director', 'Managing Director', 'Manager', 'Head of', 'VP', 'Vice President',
  'President', 'Principal', 'Lead', 'Chief', 'Consultant', 'Advisor', 'Account Executive',
  'Sales', 'Marketing', 'Operations', 'Engineer', 'Designer', 'Analyst', 'Specialist',
  'Coordinator', 'Administrator', 'Executive', 'Officer',
]

// Cut the QUOTED reply history off an email body, keeping ONLY what the lead just
// wrote (their new message + their own signature). Without this, signature
// extraction reads the quoted OUTBOUND email below and mis-attributes the AGENCY's
// company/website/title to the lead. Handles both HTML (blockquote / gmail_quote /
// Outlook divider) and plain-text ("On <date> … wrote:", "From:/Sent:", "> " quotes).
export function stripQuotedHistory(input: string): string {
  if (!input) return ''
  let s = input
  // HTML quote containers: everything from the first one onward is history.
  const htmlCuts = [
    /<blockquote[\s>]/i,
    /<div[^>]*class\s*=\s*["'][^"']*gmail_quote/i,
    /<div[^>]*id\s*=\s*["']?(?:divRplyFwdMsg|appendonsend)/i,   // Outlook reply divider
    /<hr[^>]*id\s*=\s*["']?stopSpelling/i,
  ]
  // Text-style quote markers (also present inside HTML before tag-stripping).
  const textCuts = [
    /\n?\s*-{2,}\s*Original Message\s*-{2,}/i,
    /(?:^|\n)\s*>?\s*On\b[\s\S]{0,200}?\bwrote:/i,    // "On <date> <name> wrote:"
    /(?:^|\n)\s*From:\s.+(?:\n|<br).{0,40}?(?:Sent|Date):\s/i,
    /\n\s*>/,                                          // first Gmail-style quoted line
    /\n_{5,}/,
  ]
  let idx = -1
  for (const re of [...htmlCuts, ...textCuts]) {
    const m = s.match(re)
    if (m && m.index !== undefined && (idx === -1 || m.index < idx)) idx = m.index
  }
  if (idx !== -1) s = s.slice(0, idx)
  return s
}

// Strip HTML to text so regex works on either body_text or body_html.
function toText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

// --- Phone -------------------------------------------------------------------
// Prefer a number explicitly labelled M:/Mob/Tel/T:/Phone/Direct. Fall back to a
// UK-style or international number anywhere. Reject things that look like dates,
// VAT/company numbers, or zip-only digits by requiring 9+ digits.
function extractPhone(text: string): string | null {
  const labelled = text.match(/(?:\bM(?:ob(?:ile)?)?|\bT(?:el)?|\bP(?:hone)?|\bDirect|\bDDI|\bCall)\s*[:.]?\s*(\+?[\d][\d\s().\-]{7,}\d)/i)
  const generic = text.match(/(\+?\d[\d\s().\-]{8,}\d)/)
  const raw = (labelled?.[1] ?? generic?.[1] ?? '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return null
  // Tidy spacing but keep a leading + if present.
  return raw.replace(/\s{2,}/g, ' ').trim()
}

// --- URLs --------------------------------------------------------------------
function extractPersonLinkedIn(text: string): string | null {
  const m = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i)
  return m ? m[0] : null
}
function extractCompanyLinkedIn(text: string): string | null {
  const m = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9\-_%]+\/?/i)
  return m ? m[0] : null
}
function extractWebsite(text: string, leadEmail?: string): string | null {
  // Any http(s) URL that isn't social/booking/email-tracking noise.
  const urls = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []
  const bad = /(linkedin|twitter|x\.com|facebook|instagram|youtube|calendly|zoho|hubspot|mailto|unsubscribe|\.png|\.jpg|\.gif)/i
  for (const u of urls) {
    if (!bad.test(u)) return u.replace(/[.,);]+$/, '')
  }
  // Bare domain — with OR without www. (signatures often show "NewlyBornUK.com").
  // First REMOVE all email addresses from the text so we never mistake an email's
  // domain (or a fragment of it) for the website. Then match a domain on a common
  // public TLD and skip social/noise domains.
  const noEmails = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
  const domainRe = /\b((?:www\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.(?:com|co\.uk|org|net|io|ai|dev|app|biz|info|uk|us|ca|de|fr|es|it|nl|eu|me|store|shop))\b/gi
  const cands = noEmails.match(domainRe) ?? []
  for (const d of cands) {
    if (bad.test(d)) continue
    return 'https://' + d.replace(/^https?:\/\//, '')
  }
  void leadEmail
  return null
}

// --- Title -------------------------------------------------------------------
function extractTitle(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const re = new RegExp(`^(?:[A-Za-z &/,'-]*\\b(?:${TITLE_WORDS.map(w => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b[A-Za-z &/,'-]*)$`, 'i')
  for (const line of lines) {
    if (line.length > 60) continue
    if (re.test(line)) return line.replace(/\s{2,}/g, ' ')
  }
  return null
}

// --- Company name ------------------------------------------------------------
// Find the lead's company in their signature. Prefer a line containing a legal
// suffix (Ltd/Limited/LLC/Inc/GmbH/PLC/Co); else the line right AFTER a title line
// (sigs read: Name / Title / Company). Conservative — returns null rather than guess.
// Turn a website/domain into a readable company name as a last resort, e.g.
// "https://www.myvintage.uk" → "Myvintage", "newlybornuk.com" → "Newlybornuk".
// Crude but reliable — the domain is almost always present even when the company
// line isn't parseable, and it's strictly better than the wrong imported value.
function companyFromDomain(website: string | null): string | null {
  if (!website) return null
  const host = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0]
  const label = host.split('.')[0]
  if (!label || label.length < 2) return null
  // Split camelCase / separators into words and Title-case.
  const words = label.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return words.replace(/\b\w/g, c => c.toUpperCase())
}

function extractCompany(text: string, website?: string | null): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const suffix = /\b(?:Ltd\.?|Limited|LLC|L\.L\.C\.|Inc\.?|Incorporated|PLC|GmbH|Pty|Corp\.?|Corporation|Holdings)\b/i

  // Reject lines that clearly aren't a company name: sentences, headers, URLs, etc.
  // This kills the false positives seen in the wild (subject-like sentences, SMTP/
  // DMARC strings, "Support", taglines with | or punctuation).
  const looksLikeCompany = (line: string): boolean => {
    if (!line || line.length < 2 || line.length > 60) return false
    if (!/[A-Za-z]/.test(line)) return false
    if (/[@=;:!?]|https?:|www\.|\bdmarc\b|\bspf\b|\bdkim\b|mailfrom|\.com\/|\d{4,}/i.test(line)) return false
    if (/[.!?]$/.test(line)) return false                 // ends like a sentence
    if (line.split(/\s+/).length > 6) return false        // too many words to be a name
    if (/^(re|fwd|hi|hello|hey|thanks|regards|best|cheers|sent from|support|team|the)\b/i.test(line)) return false
    if (/\|/.test(line)) return false                     // "Whale Song | WhaleSongProduct.com"
    return true
  }

  // 1) Strongest signal: a line with a legal suffix (and it must read like a name).
  for (const line of lines) {
    if (suffix.test(line) && looksLikeCompany(line)) return line.replace(/\s{2,}/g, ' ')
  }
  // 2) The line right after a title line (Name / Title / Company) — only if clean.
  const titleRe = new RegExp(`\\b(?:${TITLE_WORDS.map(w => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`, 'i')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].length <= 60 && titleRe.test(lines[i])) {
      const next = lines[i + 1]
      if (next && looksLikeCompany(next) && !titleRe.test(next)) return next.replace(/\s{2,}/g, ' ')
    }
  }
  // 3) Most reliable fallback: derive from the website domain (myvintage.uk →
  // "Myvintage"). Always better than the wrong imported company_name.
  return companyFromDomain(website ?? null)
}

// Extract the requested fields from one email body. Returns only the fields it
// actually found, mapped to their esp_leads.raw key.
export function extractSignatureFields(
  body: string,
  fields: SignatureField[],
  leadEmail?: string,
): Partial<Record<SignatureField, string>> {
  // Scan ONLY the lead's own message + signature — never the quoted outbound thread
  // below it (that carries OUR client's signature, which would be mis-attributed).
  const text = toText(stripQuotedHistory(body || ''))
  const out: Partial<Record<SignatureField, string>> = {}
  if (!text.trim()) return out

  // Resolve the website once up front so extractCompany can fall back to deriving the
  // company name from the domain when there's no parseable company line.
  const website = extractWebsite(text, leadEmail)

  for (const f of fields) {
    let v: string | null = null
    if (f === 'phone_number') v = extractPhone(text)
    else if (f === 'linkedin_person_url') v = extractPersonLinkedIn(text)
    else if (f === 'linkedin_company_url') v = extractCompanyLinkedIn(text)
    else if (f === 'company_website') v = website
    else if (f === 'job_title') v = extractTitle(text)
    else if (f === 'company_name') v = extractCompany(text, website)
    if (v) out[f] = v
  }
  return out
}
