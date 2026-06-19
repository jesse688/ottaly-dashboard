import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { ensureScrapeSchema } from '@/lib/ch-schema'

export async function GET() {
  try {
    await ensureScrapeSchema()
    const res = await pool.query(
      `SELECT id, label, status, total, done, ok, failed, error,
              created_at, started_at, finished_at
         FROM scrape_jobs
        ORDER BY created_at DESC
        LIMIT 20`
    )
    return NextResponse.json({ rows: res.rows })
  } catch (err) {
    console.error('[ch/jobs]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
