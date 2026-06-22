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

// Build a WHERE clause + params from the same query filters the companies search
// uses, so "scrape these filtered companies" matches what the user sees.
function buildChFilter(q: Record<string, string>): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (q.sic) {
    const sicArr = String(q.sic).split(',').map((s) => s.trim()).filter(Boolean)
    if (sicArr.length) {
      params.push(sicArr)
      conditions.push(`string_to_array(sic_codes, ',') && $${params.length}::text[]`)
    }
  }
  if (q.postcode_prefix) {
    params.push(q.postcode_prefix.toUpperCase() + '%')
    conditions.push(`postcode ILIKE $${params.length}`)
  }
  if (q.company_type) {
    params.push(q.company_type)
    conditions.push(`company_type ILIKE $${params.length}`)
  }
  if (q.search) {
    params.push('%' + q.search + '%')
    conditions.push(`company_name ILIKE $${params.length}`)
  }
  if (q.county) {
    params.push(q.county)
    conditions.push(`UPPER(county) = UPPER($${params.length})`)
  }
  if (q.town) {
    params.push(q.town)
    conditions.push(`UPPER(post_town) = UPPER($${params.length})`)
  }
  if (q.inc_after) {
    params.push(q.inc_after)
    conditions.push(`incorporated_on >= $${params.length}`)
  }
  if (q.inc_before) {
    params.push(q.inc_before)
    conditions.push(`incorporated_on <= $${params.length}`)
  }
  if (q.country) {
    const ctry = String(q.country).toUpperCase()
    if (ctry === 'SCOTLAND')
      conditions.push(`(postcode ILIKE 'AB%' OR postcode ILIKE 'DD%' OR postcode ILIKE 'DG%' OR postcode ILIKE 'EH%' OR postcode ILIKE 'FK%' OR postcode ILIKE 'G%' OR postcode ILIKE 'HS%' OR postcode ILIKE 'IV%' OR postcode ILIKE 'KA%' OR postcode ILIKE 'KW%' OR postcode ILIKE 'KY%' OR postcode ILIKE 'ML%' OR postcode ILIKE 'PA%' OR postcode ILIKE 'PH%' OR postcode ILIKE 'TD%' OR postcode ILIKE 'ZE%')`)
    else if (ctry === 'WALES')
      conditions.push(`(postcode ILIKE 'CF%' OR postcode ILIKE 'LD%' OR postcode ILIKE 'LL%' OR postcode ILIKE 'NP%' OR postcode ILIKE 'SA%' OR postcode ILIKE 'SY%')`)
    else if (ctry === 'NORTHERN IRELAND') conditions.push(`postcode ILIKE 'BT%'`)
  }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params }
}

// Queue a scrape/enrich job for CH businesses already in our DB. The scraper-
// service ENGINE is queue-driven: we INSERT into scrape_jobs + scrape_job_items
// and the worker claims the work. No HTTP scrape endpoint is called.
// Body: { company_numbers?: string[], filters?: {...}, fields?: string[], label?, max? }
export async function POST(req: NextRequest) {
  let body: {
    company_numbers?: string[]
    filters?: Record<string, string>
    fields?: string[]
    label?: string
    max?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const fields = normaliseFields(body.fields)
  const MAX = Math.min(50000, Math.max(1, Number(body.max) || 50000))

  const client = await pool.connect()
  try {
    let selectSql: string
    let selectParams: unknown[]
    if (Array.isArray(body.company_numbers) && body.company_numbers.length) {
      selectSql = `SELECT company_number, company_name, website FROM ch_companies WHERE company_number = ANY($1::text[]) LIMIT ${MAX}`
      selectParams = [body.company_numbers]
    } else {
      const { where, params } = buildChFilter(body.filters || {})
      selectSql = `SELECT company_number, company_name, website FROM ch_companies ${where} ORDER BY company_name LIMIT ${MAX}`
      selectParams = params
    }
    const sel = await client.query(selectSql, selectParams)
    if (!sel.rows.length) {
      return NextResponse.json(
        { error: 'No matching companies to scrape' },
        { status: 400 }
      )
    }

    const nums = sel.rows.map((r) => r.company_number)
    const names = sel.rows.map((r) => r.company_name || null)
    const domains = sel.rows.map((r) => toScrapeDomain(r.website))
    const label = (body.label || `CH: ${nums.length} companies`).slice(0, 200)

    await client.query('BEGIN')
    const job = await client.query(
      `INSERT INTO scrape_jobs (label, status, source, fields, total)
       VALUES ($1, 'queued', 'ch', $2, $3) RETURNING id`,
      [label, fields, nums.length]
    )
    const jobId = job.rows[0].id
    await client.query(
      `INSERT INTO scrape_job_items (job_id, company_number, company_name, domain)
       SELECT $1, n, nm, d FROM unnest($2::text[], $3::text[], $4::text[]) AS t(n, nm, d)`,
      [jobId, nums, names, domains]
    )
    await client.query('COMMIT')
    return NextResponse.json({ jobId, total: nums.length, fields })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ch-scrape]', e)
    return NextResponse.json({ error: 'Failed to queue scrape job' }, { status: 500 })
  } finally {
    client.release()
  }
}
