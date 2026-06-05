import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspace_id')
  const values: unknown[] = []
  const conditions: string[] = []
  if (workspaceId) { values.push(workspaceId); conditions.push(`workspace_id = $${values.length}`) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const res = await pool.query(
      `SELECT workspace_id, date, from_type, to_type, sent, replies, pos_replies, bounces, leads,
              CASE WHEN sent > 0 THEN ROUND(replies::numeric/sent, 4) ELSE 0 END AS reply_rate,
              CASE WHEN sent > 0 THEN ROUND(bounces::numeric/sent, 4) ELSE 0 END AS bounce_rate
       FROM combo_history ${where}
       ORDER BY date DESC, sent DESC`,
      values
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[combo-analysis]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
