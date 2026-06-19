import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { ensureScrapeSchema } from '@/lib/ch-schema'
import { normaliseFields } from '@/lib/enrich-fields'

interface Row {
  name?: string
  location?: string
  website?: string
}
interface Body {
  rows: Row[]
  fields?: string[]
  label?: string
}

function toDomain(website?: string): string | null {
  if (!website) return null
  const d = website
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
  return d && d.includes('.') ? d : null
}

export async function POST(req: NextRequest) {
  await ensureScrapeSchema()
  const client = await pool.connect()
  try {
    const body = (await req.json()) as Body
    const fields = normaliseFields(body.fields)
    const rows = (body.rows || []).filter((r) => (r.name && r.name.trim()) || r.website)

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No usable rows (need a name or a website)' }, { status: 400 })
    }
    if (rows.length > 5000) {
      return NextResponse.json({ error: 'Too many rows — max 5000 per job' }, { status: 400 })
    }

    const names = rows.map((r) => (r.name || '').trim() || null)
    const locations = rows.map((r) => (r.location || '').trim() || null)
    const domains = rows.map((r) => toDomain(r.website))

    await client.query('BEGIN')
    const job = await client.query(
      `INSERT INTO scrape_jobs (label, status, source, fields, total)
       VALUES ($1, 'queued', 'list', $2, $3) RETURNING id`,
      [body.label?.slice(0, 200) ?? `list: ${rows.length}`, fields, rows.length]
    )
    const jobId: number = job.rows[0].id

    await client.query(
      `INSERT INTO scrape_job_items (job_id, company_name, location, domain)
       SELECT $1, n, l, d
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(n, l, d)`,
      [jobId, names, locations, domains]
    )

    await client.query('COMMIT')
    return NextResponse.json({ jobId, total: rows.length })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[enrich]', err)
    return NextResponse.json({ error: 'Failed to queue enrichment job' }, { status: 500 })
  } finally {
    client.release()
  }
}
