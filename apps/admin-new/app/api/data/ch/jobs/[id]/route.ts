import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// One scrape/enrich job's progress + its results (joined to scraped_contacts by
// domain). Shared by the CH Pipeline and Enrichment pages for progress polling.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const jobId = parseInt(id, 10)
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: 'Bad job id' }, { status: 400 })
  }
  try {
    const jobQ = await pool.query(`SELECT * FROM scrape_jobs WHERE id = $1`, [
      jobId,
    ])
    if (!jobQ.rows.length) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }
    const items = await pool.query(
      `SELECT i.company_name, i.location, i.domain, i.status AS item_status,
              s.website, s.emails, s.phones, s.address, s.business_type,
              s.industry, s.keywords, s.description, s.socials,
              s.status AS scrape_status
         FROM scrape_job_items i
         LEFT JOIN scraped_contacts s ON s.domain = i.domain
        WHERE i.job_id = $1
        ORDER BY i.id
        LIMIT 5000`,
      [jobId]
    )
    return NextResponse.json({ job: jobQ.rows[0], items: items.rows })
  } catch (e) {
    console.error('[ch-job]', e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
