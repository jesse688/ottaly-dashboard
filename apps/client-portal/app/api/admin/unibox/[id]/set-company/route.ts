import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { setReplyCompanyByNumber } from '@/lib/enrich'

export const dynamic = 'force-dynamic'

// Manually confirm the Companies House company for a reply, for the cases where
// auto-match refused (ambiguous name like "Holmes Production" → 3 real
// companies, or no name at all). The operator supplies the exact company number
// (often visible in the reply's email signature); we resolve it directly — a
// certain match, never a guess — and write ch_data so the panel + client view
// fill in.
//
// GET  ?q=<name>  → name-search candidates (to help find the right number).
// POST { companyNumber } → confirm + write ch_data.

// CH search endpoint, proxied so the panel can list candidates without a key.
async function searchCandidates(q: string) {
  const key = process.env.COMPANIES_HOUSE_API_KEY
  if (!key) return { items: [] as { company_number: string; title: string; company_status: string; address: string }[], error: 'no_api_key' }
  const auth = 'Basic ' + Buffer.from(key + ':').toString('base64')
  const res = await fetch(
    `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}&items_per_page=10`,
    { headers: { Authorization: auth } }
  )
  if (!res.ok) return { items: [], error: `ch_${res.status}` }
  const data = await res.json() as { items?: { company_number?: string; title?: string; company_status?: string; address_snippet?: string }[] }
  const items = (data.items ?? [])
    .filter(i => i.company_number)
    .map(i => ({
      company_number: i.company_number!,
      title: i.title ?? '',
      company_status: i.company_status ?? '',
      address: i.address_snippet ?? '',
    }))
  return { items }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const url = new URL(req.url)
  let q = (url.searchParams.get('q') ?? '').trim()

  // Default the search to the reply's company name / email domain so the panel
  // opens with sensible candidates the operator can pick from.
  if (!q) {
    const r = await pool.query(
      `SELECT l.company_name, u.lead_email
         FROM unibox_replies u
         LEFT JOIN esp_leads l ON l.workspace_id = u.workspace_id AND lower(l.email) = lower(u.lead_email)
        WHERE u.id = $1 LIMIT 1`,
      [id]
    )
    const row = r.rows[0] as { company_name?: string; lead_email?: string } | undefined
    q = row?.company_name?.trim() || (row?.lead_email?.split('@')[1] ?? '').split('.')[0] || ''
  }
  if (!q) return NextResponse.json({ ok: true, query: '', items: [] })

  const { items, error } = await searchCandidates(q)
  return NextResponse.json({ ok: true, query: q, items, error })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { companyNumber?: string }
  const companyNumber = (body.companyNumber ?? '').trim()
  if (!companyNumber) return NextResponse.json({ error: 'companyNumber is required' }, { status: 400 })

  const reply = await pool.query(`SELECT id FROM unibox_replies WHERE id = $1`, [id])
  if (!reply.rows.length) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })

  const { rundown, reason } = await setReplyCompanyByNumber(id, companyNumber)
  if (!rundown) {
    const msg = reason === 'no_api_key'
      ? 'Companies House API key not configured'
      : reason === 'number_not_found'
        ? `No Companies House record for ${companyNumber}`
        : `Could not resolve company (${reason})`
    return NextResponse.json({ error: msg }, { status: 422 })
  }
  return NextResponse.json({ ok: true, ch: rundown })
}
