import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT ws_id, date, data
       FROM perf_cache_daily
       ORDER BY date DESC, saved_at DESC`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[metrics]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
