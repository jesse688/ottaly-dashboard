import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { ensureScrapeSchema } from '@/lib/ch-schema'

// Job detail + its items joined to scraped results. Used by the Enrich page
// (results table + CSV export) and any per-job drill-down.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureScrapeSchema()
    const { id } = await ctx.params
    const jobId = parseInt(id, 10)
    if (!Number.isFinite(jobId)) {
      return NextResponse.json({ error: 'Invalid job id' }, { status: 400 })
    }

    const job = await pool.query(
      `SELECT id, label, status, source, fields, total, done, ok, failed, error,
              created_at, started_at, finished_at
         FROM scrape_jobs WHERE id = $1`,
      [jobId]
    )
    if (!job.rows[0]) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const items = await pool.query(
      `SELECT i.company_name, i.location, i.domain, i.status AS item_status,
              sc.website, sc.emails, sc.phones, sc.address, sc.business_type,
              sc.industry, sc.keywords, sc.description, sc.socials,
              sc.status AS scrape_status
         FROM scrape_job_items i
         LEFT JOIN scraped_contacts sc ON sc.domain = i.domain
        WHERE i.job_id = $1
        ORDER BY i.id`,
      [jobId]
    )

    return NextResponse.json({ job: job.rows[0], items: items.rows })
  } catch (err) {
    console.error('[ch/jobs/:id]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
