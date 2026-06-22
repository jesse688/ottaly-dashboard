import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildEngineLeadsFilter } from '../route'

export async function GET(req: NextRequest) {
  const { where, params } = buildEngineLeadsFilter(req.nextUrl.searchParams)

  try {
    const { rows } = await pool.query(
      `SELECT company_name, domain, email_primary, emails, phones, director_name,
              industry, region, company_size, linkedin_url, has_products,
              product_count, platform, source, show, postcode, sic_code, company_number
       FROM ottaly_engine_leads ${where}
       ORDER BY promoted_at DESC NULLS LAST`,
      params
    )

    // Column order chosen for importing into PlusVibe (not EmailBison).
    const cols = [
      'company_name', 'domain', 'email_primary', 'emails', 'phones', 'director_name',
      'industry', 'region', 'company_size', 'linkedin_url', 'has_products',
      'product_count', 'platform', 'source', 'show', 'postcode', 'sic_code', 'company_number',
    ]
    const arr = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v == null ? '' : v)
    const esc = (v: unknown) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`)
    const csv = [
      cols.join(','),
      ...rows.map((r) =>
        [
          r.company_name, r.domain, r.email_primary, arr(r.emails), arr(r.phones), r.director_name,
          r.industry, r.region, r.company_size, r.linkedin_url, r.has_products,
          r.product_count, r.platform, r.source, r.show, r.postcode, r.sic_code, r.company_number,
        ]
          .map(esc)
          .join(',')
      ),
    ].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="engine-leads.csv"',
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[engine-leads/export] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
