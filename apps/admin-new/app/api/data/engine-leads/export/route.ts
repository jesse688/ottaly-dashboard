import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildEngineLeadsFilter } from '../route'

export async function GET(req: NextRequest) {
  const { where, params } = buildEngineLeadsFilter(req.nextUrl.searchParams)

  try {
    const { rows } = await pool.query(
      `SELECT domain, company_name, company_number, email_primary, emails,
              phones, director_name, address, postcode, sic_code, industry,
              region, company_size, linkedin_url, has_products, product_count,
              page_count, platform, promoted_at
       FROM ottaly_engine_leads ${where}
       ORDER BY promoted_at DESC NULLS LAST`,
      params
    )

    const cols = [
      'Domain', 'Company Name', 'Company Number', 'Email', 'All Emails',
      'Phones', 'Director', 'Address', 'Postcode', 'SIC Code', 'Industry',
      'Region', 'Company Size', 'LinkedIn', 'Has Products', 'Product Count',
      'Page Count', 'Platform', 'Promoted At',
    ]
    const arr = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v == null ? '' : v)
    const esc = (v: unknown) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`)
    const csv = [
      cols.join(','),
      ...rows.map((r) =>
        [
          r.domain, r.company_name, r.company_number, r.email_primary, arr(r.emails),
          arr(r.phones), r.director_name, r.address, r.postcode, r.sic_code, r.industry,
          r.region, r.company_size, r.linkedin_url, r.has_products, r.product_count,
          r.page_count, r.platform, r.promoted_at,
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
