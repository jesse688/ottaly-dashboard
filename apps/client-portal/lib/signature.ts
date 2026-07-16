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

export type SignatureField = 'phone_number' | 'mobile_phone' | 'office_phone' | 'company_website' | 'linkedin_person_url' | 'linkedin_company_url' | 'job_title' | 'company_name'

export const SIGNATURE_FIELD_LABELS: Record<SignatureField, string> = {
  phone_number: 'Phone',
  mobile_phone: 'Mobile',
  office_phone: 'Office / landline',
  company_website: 'Website',
  linkedin_person_url: 'LinkedIn (person)',
  linkedin_company_url: 'LinkedIn (company)',
  job_title: 'Job title',
  company_name: 'Company',
}

export const ALL_SIGNATURE_FIELDS: SignatureField[] = [
  'phone_number', 'mobile_phone', 'office_phone', 'company_website', 'linkedin_person_url', 'linkedin_company_url', 'job_title', 'company_name',
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
// VAT/company numbers, or zip-only digits by requiring 9–15 digits.
//
// We scan for ALL candidate numbers and pick the first VALID one, rather than a
// single greedy match. A greedy `[\d\s().-]+` run merges two adjacent numbers in
// a signature (e.g. "07875686108 0208 1029102") into one 19-digit string that
// then fails the length check — so an unlabelled mobile on its own line was lost.
function isValidPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 9 && digits.length <= 15
}
function tidyPhone(raw: string): string {
  return raw.replace(/\s{2,}/g, ' ').trim().replace(/[.\-\s]+$/, '')
}
// A phone number may sit unlabelled on its own line, OR several numbers can be
// adjacent ("07875686108 0208 1029102"). A single greedy run merges them into a
// 22-digit string that fails the length check, so an unlabelled mobile was lost.
// Strategy: pull maximal digit/space runs, then for each run try the whole then
// every contiguous space-joined sub-sequence of tokens, returning the first one
// with a valid (9–15) digit count. Verified against real UK mobiles, spaced
// landlines, +intl, and date/time false-positives.
function extractPhone(text: string): string | null {
  // 1) Labelled number wins (M:/Mob/Tel/T:/Phone/Direct/DDI/Call).
  const labelled = text.match(/(?:\bM(?:ob(?:ile)?)?|\bT(?:el)?|\bP(?:hone)?|\bDirect|\bDDI|\bCall)\s*[:.]?\s*(\+?\d[\d().\-]*(?:\s+[\d(][\d().\-]*){0,3})/i)
  if (labelled?.[1]) {
    const t = tidyPhone(labelled[1])
    if (isValidPhone(t)) return t
    const parts = t.split(/\s+/)
    for (let i = parts.length; i > 0; i--) { const j = parts.slice(0, i).join(' '); if (isValidPhone(j)) return tidyPhone(j) }
  }
  // 2) Unlabelled: scan runs and split merged ones. Allow MULTIPLE spaces between
  //    groups ("+44 (0)  7413" has a double space) so a number isn't cut short.
  const runs = text.match(/\+?\d[\d().\-]*(?:\s+[\d(][\d().\-]*){0,4}/g) ?? []
  for (const run of runs) {
    if (isValidPhone(run)) return tidyPhone(run)
    const parts = run.trim().split(/\s+/)
    for (let s = 0; s < parts.length; s++)
      for (let e = s + 1; e <= parts.length; e++) {
        const cand = parts.slice(s, e).join(' ')
        if (isValidPhone(cand)) return tidyPhone(cand)
      }
  }
  return null
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
// Hosts that appear in signatures/email HTML but are NEVER the prospect's own
// website: social, scheduling/CRM, marketing/tracking, review sites, code/dev,
// CDNs and asset hosts. A URL on one of these is noise — grabbing it as the
// "website" is exactly how we ended up with github.com / fonts.googleapis.com /
// trustpilot.com as company sites (and fake company names derived from them).
const BAD_HOST = /(?:^|\.)(?:linkedin|twitter|x|facebook|fb|instagram|youtube|youtu\.be|tiktok|pinterest|calendly|cal\.com|zoho|hubspot|mailchimp|sendgrid|sendgrid\.net|constantcontact|klaviyo|list-manage|mailgun|amazonses|awstrack|google|googleapis|gstatic|cloudfront|akamai|jsdelivr|unpkg|bootstrapcdn|fontawesome|github|githubusercontent|gitlab|bitbucket|trustpilot|glassdoor|yelp|feefo|reviews\.io|bit\.ly|tinyurl|t\.co|lnkd\.in|hs-sites|hsforms|typeform|docs\.google|drive\.google|dropbox|wetransfer|caseboard|notion\.so|substack|medium|wordpress\.org|w3\.org|schema\.org|sentry|segment|intercom|drift|zendesk|freshdesk)\./i
const BAD_URL = /(linkedin|twitter|x\.com|facebook|instagram|youtube|calendly|zoho|hubspot|mailto|unsubscribe|\.png|\.jpe?g|\.gif|\.svg|\.css|\.js|\.woff2?|\.ico|\/issues\/|\/pull\/|\/blob\/|\/review\/|googleapis\.com|gstatic\.com|github\.com|githubusercontent|trustpilot|caseboard)/i

function hostOf(u: string): string {
  return u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase()
}
// The registrable-ish core of a host for comparison: drop www + TLD parts, keep
// the main label. "mail.einhell.com" → "einhell", "acme.co.uk" → "acme".
function domainCore(host: string): string {
  const parts = host.replace(/^www\./, '').split('.')
  if (parts.length <= 1) return parts[0] ?? ''
  // Handle co.uk / com.au style: the core is the label before a 2-part public suffix.
  const twoPart = /^(co|com|org|net|ac|gov)\.[a-z]{2}$/i.test(parts.slice(-2).join('.'))
  return (twoPart ? parts[parts.length - 3] : parts[parts.length - 2]) ?? ''
}

function extractWebsite(text: string, leadEmail?: string): string | null {
  // The lead's own email domain is the ground truth for their company site.
  const emailHost = leadEmail && leadEmail.includes('@') ? hostOf(leadEmail.split('@')[1]) : ''
  const emailCore = emailHost ? domainCore(emailHost) : ''
  // Free-mail domains: the email domain tells us nothing about the company site.
  const freeMail = /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|aol|protonmail|proton|gmx|mail|msn)\.[a-z.]+$/i.test(emailHost)

  const isNoise = (u: string): boolean => BAD_URL.test(u) || BAD_HOST.test(hostOf(u))

  // 1) Best: a URL whose host matches the lead's own email domain (their real site).
  const urls = (text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []).map(u => u.replace(/[.,);]+$/, ''))
  if (emailCore && !freeMail) {
    for (const u of urls) {
      if (!isNoise(u) && domainCore(hostOf(u)) === emailCore) return u
    }
  }
  // 2) Otherwise the first non-noise URL (kept conservative via the expanded blocklist).
  for (const u of urls) {
    if (!isNoise(u)) return u
  }
  // 3) Bare domain — with OR without www. (signatures often show "NewlyBornUK.com").
  // First REMOVE all email addresses from the text so we never mistake an email's
  // domain (or a fragment of it) for the website. Then match a domain on a common
  // public TLD and skip social/noise domains.
  const noEmails = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
  const domainRe = /\b((?:www\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.(?:com|co\.uk|org|net|io|ai|dev|app|biz|info|uk|us|ca|de|fr|es|it|nl|eu|me|store|shop))\b/gi
  const cands = noEmails.match(domainRe) ?? []
  // Prefer a bare domain matching the email core, else the first non-noise one.
  if (emailCore && !freeMail) {
    for (const d of cands) {
      if (!BAD_HOST.test(d) && !BAD_URL.test(d) && domainCore(d) === emailCore) {
        return 'https://' + d.replace(/^https?:\/\//, '')
      }
    }
  }
  for (const d of cands) {
    if (BAD_HOST.test(d) || BAD_URL.test(d)) continue
    return 'https://' + d.replace(/^https?:\/\//, '')
  }
  // 4) Last resort: if the email is a company domain (not free-mail), the domain
  // itself is a reliable company site — better than nothing.
  if (emailHost && !freeMail) return 'https://' + emailHost
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
  // Use the registrable label (the part before the public suffix), not the first
  // subdomain — "hello.email.trustedhousesitters.com" → "trustedhousesitters",
  // not "hello". Strips common mail/notification subdomains that would mislead.
  const label = domainCore(host)
  if (!label || label.length < 2) return null
  // Split camelCase / separators into words and Title-case.
  const words = label.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return words.replace(/\b\w/g, c => c.toUpperCase())
}

// Field labels that appear on their own line in signatures (often followed by the
// value on the next line). These must NEVER be taken as a company name — that's
// how "Phone" ended up as a company (it was the label above a phone number).
const LABEL_ONLY = /^(?:phone|tel|telephone|mobile|mob|cell|fax|email|e-mail|mail|web|website|url|address|addr|office|direct|linkedin|twitter|instagram|facebook|whatsapp|skype|www)\b[:\s]*$/i

// Is a stored/imported company name detectable JUNK worth overwriting? Empty, a
// URL, a bare field label ("Phone"), "null", or an address blob. A merely-different
// but plausible name ("Cheese Riot", "Tenzo") is NOT junk — callers must not clobber
// it with a lower-confidence extraction (e.g. a domain-squash "Cheeseriot"). Shared
// by the runtime enrich paths so a reply never downgrades a good name.
export function isJunkCompanyName(v: string | null | undefined): boolean {
  const s = (v ?? '').trim()
  if (!s) return true
  if (/^null$/i.test(s)) return true
  if (/https?:|www\.|\.com\/|\.co\.uk|\.io\b|\.net\b/i.test(s)) return true
  if (LABEL_ONLY.test(s)) return true
  if (/^\d/.test(s)) return true                                                       // starts with a number → address
  if (/\b(street|road|lane|avenue|place|court|house|unit|floor|suite|drive|way)\b/i.test(s) && /\d/.test(s)) return true
  return false
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
    if (LABEL_ONLY.test(line)) return false               // bare "Phone" / "Email" / "Web"
    if (/[@=;:!?]|https?:|www\.|\bdmarc\b|\bspf\b|\bdkim\b|mailfrom|\.com\/|\d{4,}/i.test(line)) return false
    if (/[.!?]$/.test(line)) return false                 // ends like a sentence
    if (line.split(/\s+/).length > 6) return false        // too many words to be a name
    if (/^(re|fwd|hi|hello|hey|thanks|regards|best|cheers|sent from|support|team|the)\b/i.test(line)) return false
    if (/\|/.test(line)) return false                     // "Whale Song | WhaleSongProduct.com"
    return true
  }

  // A company website is our most trustworthy anchor (it's derived from the lead's
  // own email domain, see extractWebsite). Prefer it over shaky signature-text
  // heuristics that historically produced junk ("Phone", "Colds", "Explore sits").
  const fromDomain = companyFromDomain(website ?? null)

  // 1) Strongest text signal: a line with a legal suffix. If the line is a long
  //    address blob ("Einhell UK Ltd, Unit 10, ..."), keep only the company part
  //    (text up to the first comma) so a real "<Name> Ltd" is recovered.
  for (const raw of lines) {
    if (!suffix.test(raw)) continue
    const head = raw.split(/\s*[,|]\s*/)[0].trim()      // company portion before address
    if (suffix.test(head) && looksLikeCompany(head)) return head.replace(/\s{2,}/g, ' ')
    if (looksLikeCompany(raw)) return raw.replace(/\s{2,}/g, ' ')
  }
  // 2) Prefer the domain-derived company over the "line after a title" heuristic —
  //    the latter grabs the next label ("Phone") when the sig has no company line.
  if (fromDomain) return fromDomain
  // 3) Last resort: the line right after a title line (Name / Title / Company).
  const titleRe = new RegExp(`\\b(?:${TITLE_WORDS.map(w => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`, 'i')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].length <= 60 && titleRe.test(lines[i])) {
      const next = lines[i + 1]
      if (next && looksLikeCompany(next) && !titleRe.test(next)) return next.replace(/\s{2,}/g, ' ')
    }
  }
  return null
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
    if (f === 'phone_number') v = extractMobile(text) ?? extractPhone(text)
    else if (f === 'mobile_phone') v = extractMobile(text)
    else if (f === 'office_phone') v = extractOffice(text)
    else if (f === 'linkedin_person_url') v = extractPersonLinkedIn(text)
    else if (f === 'linkedin_company_url') v = extractCompanyLinkedIn(text)
    else if (f === 'company_website') v = website
    else if (f === 'job_title') v = extractTitle(text)
    else if (f === 'company_name') v = extractCompany(text, website)
    if (v) out[f] = v
  }
  return out
}

// Extract a number labelled as a MOBILE (M:/Mob/Mobile/Cell). Signatures often
// list two numbers — a mobile and an office/landline — each with its own label
// (e.g. "M: +44 (0) 7413 786773" / "O: +44 (0) 843 886 8408"), so we capture
// them separately and tag which is which.
// Pick the first valid phone out of a (possibly merged) captured run: try the
// whole, then every contiguous space-joined sub-sequence of tokens. Handles
// "+44 (0) 7413 786773" (spaces + parens) and two numbers run together.
function firstValidFromRun(run: string): string | null {
  const t = tidyPhone(run)
  if (isValidPhone(t)) return t
  const parts = t.split(/\s+/)
  for (let s = 0; s < parts.length; s++)
    for (let e = s + 1; e <= parts.length; e++) {
      const cand = parts.slice(s, e).join(' ')
      if (isValidPhone(cand)) return tidyPhone(cand)
    }
  return null
}
function extractLabelled(text: string, labels: string): string | null {
  // Allow (), spaces and a leading +/(0) in the run after the label — a single
  // space group may be followed by '(' (e.g. "+44 (0) 7413"), not just a digit.
  const re = new RegExp(`(?:${labels})\\s*[:.)]?\\s*(\\+?[\\d(][\\d().\\-]*(?:\\s+[\\d(][\\d().\\-]*){0,4})`, 'i')
  const m = text.match(re)
  return m?.[1] ? firstValidFromRun(m[1]) : null
}
function extractMobile(text: string): string | null {
  // Mobile labels, OR an unlabelled UK mobile (07… / +447…) anywhere. Allow
  // MULTIPLE spaces between groups ("+44 (0)  7413").
  const labelled = extractLabelled(text, 'M|Mob|Mobile|Cell')
  if (labelled) return labelled
  const m = text.match(/(\+?(?:44\s*\(?0?\)?\s*|0)7[\d().\-]*(?:\s+[\d(][\d().\-]*){0,3})/)
  return m?.[1] ? firstValidFromRun(m[1]) : null
}
function extractOffice(text: string): string | null {
  // Office / landline / direct labels.
  return extractLabelled(text, 'O|Off|Office|T|Tel|Telephone|D|Direct|DDI|Landline|L')
}
