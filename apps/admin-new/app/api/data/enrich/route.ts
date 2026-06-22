import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// Canonical catalog of extractable fields — mirror of legacy ch-fields.js.
const ALL_FIELD_KEYS = [
  'website',
  'emails',
  'phones',
  'address',
  'social_links',
  'description',
  'business_type',
  'industry',
  'keywords',
] as const
const DEFAULT_FIELD_KEYS = [
  'website',
  'emails',
  'phones',
  'address',
  'business_type',
  'industry',
]

function normaliseFields(fields: unknown): string[] {
  const set = new Set(Array.isArray(fields) ? (fields as string[]) : [])
  const picked = ALL_FIELD_KEYS.filter((k) => set.has(k))
  return picked.length ? picked : DEFAULT_FIELD_KEYS
}

function toScrapeDomain(website: unknown): string | null {
  if (!website) return null
  const d = String(website)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
  return d && d.includes('.') ? d : null
}

type EnrichRow = { name?: string; location?: string; website?: string }

// Queue an enrichment job from a flexible pasted/uploaded list (no CH needed).
// Body: { rows: [{name?, location?, website?}], fields?: string[], label? }
export async function POST(req: NextRequest) {
  let body: { rows?: EnrichRow[]; fields?: string[]; label?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const fields = normaliseFields(body.fields)
  const rows = (Array.isArray(body.rows) ? body.rows : []).filter(
    (r) => r && ((r.name && String(r.name).trim()) || r.website)
  )
  if (!rows.length) {
    return NextResponse.json(
      { error: 'No usable rows (need a name or a website)' },
      { status: 400 }
    )
  }
  if (rows.length > 5000) {
    return NextResponse.json(
      { error: 'Too many rows — max 5000 per job' },
      { status: 400 }
    )
  }

  const names = rows.map((r) => (r.name ? String(r.name).trim() : '') || null)
  const locations = rows.map(
    (r) => (r.location ? String(r.location).trim() : '') || null
  )
  const domains = rows.map((r) => toScrapeDomain(r.website))
  const label = (body.label || `list: ${rows.length}`).slice(0, 200)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const job = await client.query(
      `INSERT INTO scrape_jobs (label, status, source, fields, total)
       VALUES ($1, 'queued', 'list', $2, $3) RETURNING id`,
      [label, fields, rows.length]
    )
    const jobId = job.rows[0].id
    await client.query(
      `INSERT INTO scrape_job_items (job_id, company_name, location, domain)
       SELECT $1, n, l, d FROM unnest($2::text[], $3::text[], $4::text[]) AS t(n, l, d)`,
      [jobId, names, locations, domains]
    )
    await client.query('COMMIT')
    return NextResponse.json({ jobId, total: rows.length, fields })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[enrich]', e)
    return NextResponse.json(
      { error: 'Failed to queue enrichment job' },
      { status: 500 }
    )
  } finally {
    client.release()
  }
}
