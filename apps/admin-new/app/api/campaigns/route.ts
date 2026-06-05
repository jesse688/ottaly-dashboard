import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         c.id, c.name, c.workspace_id, c.status,
         ws.workspace_name,
         COALESCE((ws.stats->>'sent_30d')::int, 0) AS sent,
         COALESCE((ws.stats->>'replied_30d')::int, 0) AS replies,
         COALESCE((ws.stats->>'bounces_30d')::int, 0) AS bounces,
         COALESCE((ws.stats->>'reply_rate_30d')::numeric, 0) AS reply_rate,
         c.created_at, c.updated_at
       FROM campaigns c
       LEFT JOIN workspace_stats ws ON ws.workspace_id = c.workspace_id
       ORDER BY c.created_at DESC`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[campaigns]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
