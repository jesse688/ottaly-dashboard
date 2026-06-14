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

export type SignatureField = 'phone_number' | 'company_website' | 'linkedin_person_url' | 'linkedin_company_url' | 'job_title'

export const SIGNATURE_FIELD_LABELS: Record<SignatureField, string> = {
  phone_number: 'Phone / mobile',
  company_website: 'Website',
  linkedin_person_url: 'LinkedIn (person)',
  linkedin_company_url: 'LinkedIn (company)',
  job_title: 'Job title',
}

export const ALL_SIGNATURE_FIELDS: SignatureField[] = [
  'phone_number', 'company_website', 'linkedin_person_url', 'linkedin_company_url', 'job_title',
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
  // Bare domain (e.g. www.foo.co.uk) — prefer one matching the sender's domain.
  const domains = text.match(/\b(?:www\.)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/gi) ?? []
  if (domains[0]) return 'https://' + domains[0].replace(/^https?:\/\//, '')
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

// Extract the requested fields from one email body. Returns only the fields it
// actually found, mapped to their esp_leads.raw key.
export function extractSignatureFields(
  body: string,
  fields: SignatureField[],
  leadEmail?: string,
): Partial<Record<SignatureField, string>> {
  const text = toText(body || '')
  const out: Partial<Record<SignatureField, string>> = {}
  if (!text.trim()) return out

  for (const f of fields) {
    let v: string | null = null
    if (f === 'phone_number') v = extractPhone(text)
    else if (f === 'linkedin_person_url') v = extractPersonLinkedIn(text)
    else if (f === 'linkedin_company_url') v = extractCompanyLinkedIn(text)
    else if (f === 'company_website') v = extractWebsite(text, leadEmail)
    else if (f === 'job_title') v = extractTitle(text)
    if (v) out[f] = v
  }
  return out
}
