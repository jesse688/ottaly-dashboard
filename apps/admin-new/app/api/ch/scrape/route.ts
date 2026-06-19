import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildChWhere, ChFilter } from '@/lib/ch'
import { ensureScrapeSchema } from '@/lib/ch-schema'

interface ScrapeBody {
  mode: 'selected' | 'filtered'
  label?: string
  companyNumbers?: string[]
  filter?: ChFilter
}

export async function POST(req: NextRequest) {
  await ensureScrapeSchema()
  const client = await pool.connect()
  try {
    const body = (await req.json()) as ScrapeBody
    const label = body.label?.slice(0, 200) ?? null

    await client.query('BEGIN')
    const job = await client.query(
      `INSERT INTO scrape_jobs (label, status) VALUES ($1, 'queued') RETURNING id`,
      [label]
    )
    const jobId: number = job.rows[0].id

    let total = 0
    if (body.mode === 'selected') {
      const nums = (body.companyNumbers ?? []).filter(Boolean)
      if (nums.length === 0) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'No companies selected' }, { status: 400 })
      }
      const ins = await client.query(
        `INSERT INTO scrape_job_items (job_id, company_number, company_name, domain)
         SELECT $1, c.company_number, c.company_name, NULLIF(c.website, '')
           FROM ch_companies c
          WHERE c.company_number = ANY($2::text[])`,
        [jobId, nums]
      )
      total = ins.rowCount ?? 0
    } else if (body.mode === 'filtered') {
      const { where, values } = buildChWhere(body.filter ?? {})
      const ins = await client.query(
        `INSERT INTO scrape_job_items (job_id, company_number, company_name, domain)
         SELECT ${jobId}, c.company_number, c.company_name, NULLIF(c.website, '')
           FROM ch_companies c
           ${where}`,
        values
      )
      total = ins.rowCount ?? 0
    } else {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
    }

    if (total === 0) {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'No matching companies to scrape' }, { status: 400 })
    }

    await client.query(`UPDATE scrape_jobs SET total = $2 WHERE id = $1`, [jobId, total])
    await client.query('COMMIT')
    return NextResponse.json({ jobId, total })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ch/scrape]', err)
    return NextResponse.json({ error: 'Failed to queue scrape job' }, { status: 500 })
  } finally {
    client.release()
  }
}
