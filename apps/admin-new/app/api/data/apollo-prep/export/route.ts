import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// Size + count capped CSV export of database contacts, split by company_region
// for an Apollo "account". Mirrors the legacy /api/contacts/export endpoint:
// 50k rows per file, with X-Has-More / X-Next-Offset / X-Rows-In-File headers
// so the page can loop and download multiple files.
const LIMIT = 50000 // 50k rows per file

// Same non-negotiable cleanliness guard as the legacy export — only verified-
// clean, not-opted-out, non-hard-bounced addresses ever leave in a CSV.
const CLEAN = `
  AND LOWER(COALESCE(email_status,'')) IN ('safe','safe_catchall')
  AND COALESCE(do_not_contact, false) = false
  AND COALESCE(LOWER(bounce_type),'') <> 'hard'`

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const regions = (p.get('companyRegion') || '')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
  const offset = parseInt(p.get('offset') || '0', 10) || 0

  if (!regions.length) {
    return NextResponse.json({ error: 'companyRegion required' }, { status: 400 })
  }

  try {
    const placeholders = regions.map((_, i) => `$${i + 1}`).join(',')

    const countRes = await pool.query(
      `SELECT COUNT(*) AS n FROM contacts
       WHERE company_region = ANY(ARRAY[${placeholders}]::text[]) AND email IS NOT NULL${CLEAN}`,
      regions
    )
    const total = parseInt(countRes.rows[0].n, 10)

    const params = [...regions, LIMIT, offset]
    const { rows } = await pool.query(
      `SELECT email, first_name, last_name, company_name, company_domain, apollo_id
       FROM contacts
       WHERE company_region = ANY(ARRAY[${placeholders}]::text[]) AND email IS NOT NULL${CLEAN}
       ORDER BY company_domain, email
       LIMIT $${regions.length + 1} OFFSET $${regions.length + 2}`,
      params
    )

    // Minimal upload: just enough for Apollo to identify the contact + company.
    // Phone, LinkedIn, title, industry, location are intentionally omitted so
    // Apollo fills them from its own live database (paid enrichment fields).
    const cols = ['First Name', 'Last Name', 'Email', 'Company Name', 'Website', 'Apollo Contact Id']
    const esc = (v: unknown) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`)
    const csv = [
      cols.join(','),
      ...rows.map(r =>
        [r.first_name, r.last_name, r.email, r.company_name, r.company_domain, r.apollo_id]
          .map(esc)
          .join(',')
      ),
    ].join('\n')

    const nextOffset = offset + rows.length
    const hasMore = nextOffset < total

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="export-${offset}.csv"`,
        'X-Has-More': hasMore ? 'true' : 'false',
        'X-Next-Offset': String(nextOffset),
        'X-Rows-In-File': String(rows.length),
      },
    })
  } catch (err) {
    console.error('[apollo-prep/export]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
