import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Read-only aggregate stats over the full contacts table.
// Ported faithfully from legacy GET /api/admin/database/stats.
// "Unique emails" / "unique domains" counts plus enrichment-coverage breakdowns.
export async function GET() {
  try {
    const { rows } = await pool.query(`
      WITH email_agg AS (
        SELECT
          MAX(NULLIF(keywords,  '')) AS max_keywords,
          MAX(NULLIF(industry,  '')) AS max_industry,
          MAX(num_employees)         AS max_employees,
          MAX(NULLIF(city,      '')) AS max_city
        FROM contacts
        GROUP BY email
      ),
      domain_agg AS (
        SELECT
          MAX(NULLIF(keywords,  '')) AS max_keywords,
          MAX(NULLIF(industry,  '')) AS max_industry,
          MAX(num_employees)         AS max_employees,
          MAX(NULLIF(city,      '')) AS max_city
        FROM contacts
        WHERE company_domain IS NOT NULL AND company_domain != ''
        GROUP BY company_domain
      )
      SELECT
        (SELECT COUNT(*)                                       FROM email_agg)  AS total,
        (SELECT COUNT(*) FILTER (WHERE max_keywords  IS NULL)  FROM email_agg)  AS missing_keywords,
        (SELECT COUNT(*) FILTER (WHERE max_industry  IS NULL)  FROM email_agg)  AS missing_industry,
        (SELECT COUNT(*) FILTER (WHERE max_employees IS NULL)  FROM email_agg)  AS missing_num_employees,
        (SELECT COUNT(*) FILTER (WHERE max_city      IS NULL)  FROM email_agg)  AS missing_city,
        (SELECT COUNT(*)                                          FROM domain_agg) AS total_domains,
        (SELECT COUNT(*) FILTER (WHERE max_keywords  IS NOT NULL) FROM domain_agg) AS domains_with_keywords,
        (SELECT COUNT(*) FILTER (WHERE max_industry  IS NOT NULL) FROM domain_agg) AS domains_with_industry,
        (SELECT COUNT(*) FILTER (WHERE max_employees IS NOT NULL) FROM domain_agg) AS domains_with_employees,
        (SELECT COUNT(*) FILTER (WHERE max_city      IS NOT NULL) FROM domain_agg) AS domains_with_city
    `)
    return NextResponse.json(rows[0])
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[database/stats] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
