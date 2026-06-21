import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// List recent scrape/enrich jobs (newest first) for the jobs panel + polling.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, status, source, fields, total, done, ok, failed, error,
              created_at, started_at, finished_at
         FROM scrape_jobs ORDER BY id DESC LIMIT 50`
    )
    return NextResponse.json({ rows })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
