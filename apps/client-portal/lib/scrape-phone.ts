import pool from './db'

// Website phone scrape — the LAST-RESORT fallback for a missing phone. The
// lead's email signature (and our contacts DB) are the PRIMARY sources; this
// only runs for a lead that still has NO phone after those. Best-effort single-
// page scrape (homepage + common contact pages), regex-extracted, prefers tel:.

function ensureUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

function extractPhone(text: string): string | null {
  const runs = text.match(/(?:\+?\d[\d().\-]*(?:\s+[\d(][\d().\-]*){0,4})/g) ?? []
  const valid = (s: string) => { const d = s.replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 }
  const tidy = (s: string) => s.replace(/\s{2,}/g, ' ').trim().replace(/[.\-\s]+$/, '')
  for (const run of runs) {
    if (valid(run)) return tidy(run)
    const parts = run.trim().split(/\s+/)
    for (let s = 0; s < parts.length; s++) for (let e = s + 1; e <= parts.length; e++) { const c = parts.slice(s, e).join(' '); if (valid(c)) return tidy(c) }
  }
  return null
}

function phoneFromHtml(html: string): string | null {
  const tel = html.match(/href=["']tel:([+\d][\d().\-\s]{6,}\d)["']/i)
  if (tel?.[1]) { const d = tel[1].replace(/\D/g, ''); if (d.length >= 9 && d.length <= 15) return tel[1].replace(/\s{2,}/g, ' ').trim() }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  const ctx = text.match(/(?:tel|phone|call|mobile|contact)[^0-9+]{0,20}(\+?\d[\d().\-\s]{7,}\d)/i)
  if (ctx?.[1]) { const p = extractPhone(ctx[1]); if (p) return p }
  return extractPhone(text)
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OttalyBot/1.0)' }, signal: AbortSignal.timeout(10000), redirect: 'follow' })
    // NOTE: don't bail on non-2xx. Some sites (e.g. misconfigured WordPress
    // behind a proxy) return the FULL, correct HTML body with a 500/503 status.
    // We still want to scrape that body. Only skip clearly-empty responses.
    const ct = res.headers.get('content-type') || ''
    if (ct && !ct.includes('html') && !ct.includes('text')) return null
    const body = (await res.text()).slice(0, 500_000)
    return body.length > 100 ? body : null
  } catch { return null }
}

const GENERIC_DOMAIN = /^(gmail|outlook|hotmail|yahoo|icloud|aol|live|msn|gmx|protonmail|proton|me)\.[a-z.]+$/i

// Resolve the site to scrape: stored company_website, else the email domain
// (unless it's a generic mailbox provider).
export function siteForLead(email: string | null, website: string | null): string | null {
  const w = (website || '').trim()
  if (w) return w
  const domain = (email || '').split('@')[1] || ''
  if (domain && !GENERIC_DOMAIN.test(domain)) return domain
  return null
}

// Scrape a website for a phone. Returns the phone or null. Pure fetch — no DB.
export async function scrapePhoneFromSite(site: string): Promise<string | null> {
  const base = ensureUrl(site).replace(/\/+$/, '')
  for (const url of [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`]) {
    const html = await fetchPage(url)
    if (!html) continue
    const phone = phoneFromHtml(html)
    if (phone) return phone
  }
  return null
}

// Enrich ONE lead's missing phone from its website. No-op if it already has a
// phone (signature/contacts are primary). Writes raw.phone_number (+ mobile_
// phone if empty). Returns the phone written, or null. Best-effort.
export async function enrichPhoneFromWebsite(leadId: string, workspaceId: string): Promise<string | null> {
  try {
    const r = await pool.query(
      `SELECT email, raw->>'company_website' AS website,
              NULLIF(btrim(raw->>'phone_number'),'') AS phone,
              NULLIF(btrim(raw->>'mobile_phone'),'')  AS mobile
         FROM esp_leads WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [leadId, workspaceId]
    )
    const lead = r.rows[0]
    if (!lead) return null
    if (lead.phone || lead.mobile) return null   // already have a phone — signature/contacts won; skip
    const site = siteForLead(lead.email, lead.website)
    if (!site) return null
    const phone = await scrapePhoneFromSite(site)
    if (!phone) return null
    const patch: Record<string, string> = { phone_number: phone, mobile_phone: phone }
    await pool.query(
      `UPDATE esp_leads SET raw = COALESCE(raw,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [leadId, workspaceId, JSON.stringify(patch)]
    )
    return phone
  } catch (err) {
    console.error('[enrichPhoneFromWebsite] failed:', err)
    return null
  }
}
