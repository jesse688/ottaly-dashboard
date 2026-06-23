import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// On-demand website scrape to fill a MISSING phone for one lead. Fetches the
// lead's company website (homepage + a likely contact page) and regex-extracts
// the first valid phone, then writes it to esp_leads.raw->>'phone_number' (and
// mobile_phone if empty). Instant — no queue. Best-effort single-page scrape.

async function ownsLead(leadId: string, workspaceId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM esp_leads WHERE id = $1 AND workspace_id = $2 LIMIT 1', [leadId, workspaceId])
  return r.rows.length > 0
}

function ensureUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

// Phone extraction: pull number-like runs, return the first with 9–15 digits.
// Skips digit strings that are clearly not phones (long IDs handled by length).
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

// Prefer a `tel:` link (most reliable), else a labelled/loose number in text.
function phoneFromHtml(html: string): string | null {
  const tel = html.match(/href=["']tel:([+\d][\d().\-\s]{6,}\d)["']/i)
  if (tel?.[1]) { const d = tel[1].replace(/\D/g, ''); if (d.length >= 9 && d.length <= 15) return tel[1].replace(/\s{2,}/g, ' ').trim() }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  // Bias toward a "phone/tel/call/contact" context window if present.
  const ctx = text.match(/(?:tel|phone|call|mobile|contact)[^0-9+]{0,20}(\+?\d[\d().\-\s]{7,}\d)/i)
  if (ctx?.[1]) { const p = extractPhone(ctx[1]); if (p) return p }
  return extractPhone(text)
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OttalyBot/1.0)' }, signal: AbortSignal.timeout(10000), redirect: 'follow' })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('html') && !ct.includes('text')) return null
    return (await res.text()).slice(0, 500_000)
  } catch { return null }
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!await ownsLead(id, session.workspaceId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Resolve the website to scrape: stored company_website, else the email domain.
  const r = await pool.query(
    `SELECT email, raw->>'company_website' AS website, raw->>'phone_number' AS phone, raw->>'mobile_phone' AS mobile
       FROM esp_leads WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [id, session.workspaceId]
  )
  const lead = r.rows[0]
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  let site = (lead.website || '').trim()
  if (!site) {
    const domain = (lead.email || '').split('@')[1] || ''
    // Skip generic mailbox providers — their domain isn't the company site.
    if (domain && !/^(gmail|outlook|hotmail|yahoo|icloud|aol|live|msn)\./i.test(domain) && !/^(gmail|outlook|hotmail|yahoo|icloud|aol)\.com$/i.test(domain)) site = domain
  }
  if (!site) return NextResponse.json({ ok: false, reason: 'no_website', message: 'No company website or usable domain for this lead.' })

  const base = ensureUrl(site).replace(/\/+$/, '')
  // Try homepage first, then common contact paths.
  const candidates = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`]
  let found: string | null = null
  for (const url of candidates) {
    const html = await fetchPage(url)
    if (!html) continue
    found = phoneFromHtml(html)
    if (found) break
  }

  if (!found) return NextResponse.json({ ok: false, reason: 'not_found', message: 'No phone found on the website.', scanned: candidates })

  // Write to raw.phone_number (always) and raw.mobile_phone when that's empty.
  // Merge with || so we set both keys in one go; phone_number always overwrites.
  const patch: Record<string, string> = { phone_number: found }
  if (!lead.mobile) patch.mobile_phone = found
  await pool.query(
    `UPDATE esp_leads SET raw = COALESCE(raw,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2`,
    [id, session.workspaceId, JSON.stringify(patch)]
  )

  return NextResponse.json({ ok: true, phone: found, source: 'website' })
}
