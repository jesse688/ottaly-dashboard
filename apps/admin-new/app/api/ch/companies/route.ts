import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildChWhere, ChFilter } from '@/lib/ch'
import { ensureScrapeSchema } from '@/lib/ch-schema'

export async function GET(req: NextRequest) {
  try {
    await ensureScrapeSchema()
    const sp = req.nextUrl.searchParams
    const filter: ChFilter = {
      q: sp.get('q') ?? '',
      sic: sp.get('sic') ?? '',
      status: sp.get('status') ?? '',
      hasWebsite: (sp.get('hasWebsite') ?? '') as ChFilter['hasWebsite'],
      scraped: (sp.get('scraped') ?? '') as ChFilter['scraped'],
    }
    const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '300', 10) || 300, 1), 1000)
    const { where, values } = buildChWhere(filter)

    const rows = await pool.query(
      `SELECT c.company_number, c.company_name, c.company_status, c.sic_codes,
              c.postcode, c.website,
              sc.domain      AS scraped_domain,
              sc.emails      AS emails,
              sc.phones      AS phones,
              sc.status      AS scrape_status,
              sc.scraped_at  AS scraped_at
         FROM ch_companies c
         LEFT JOIN LATERAL (
           SELECT domain, emails, phones, status, scraped_at
             FROM scraped_contacts s
            WHERE s.company_number = c.company_number
            ORDER BY s.scraped_at DESC
            LIMIT 1
         ) sc ON true
         ${where}
         ORDER BY c.company_name
         LIMIT ${limit}`,
      values
    )

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ch_companies c ${where}`,
      values
    )

    return NextResponse.json({
      rows: rows.rows,
      total: count.rows[0]?.n ?? 0,
      limit,
    })
  } catch (err) {
    console.error('[ch/companies]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
