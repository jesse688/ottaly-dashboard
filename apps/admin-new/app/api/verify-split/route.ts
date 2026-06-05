import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         verification_method,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'verified') AS verified,
         COUNT(*) FILTER (WHERE status = 'catch_all') AS catch_all,
         COUNT(*) FILTER (WHERE status = 'invalid') AS invalid,
         COUNT(*) FILTER (WHERE status = 'unknown') AS unknown
       FROM contacts
       WHERE verification_method IS NOT NULL
       GROUP BY verification_method
       ORDER BY total DESC`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[verify-split]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
