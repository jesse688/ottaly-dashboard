import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         domain, workspace_id, workspace_name, score, status,
         spf, dkim, dmarc, mx, blacklists,
         last_checked, notes, ignored_at,
         pm_verified_at
       FROM domain_health
       WHERE ignored_at IS NULL
       ORDER BY score ASC NULLS LAST, domain`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[domains]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
