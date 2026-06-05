import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const workspaceId = p.get('workspace_id')

  const conditions: string[] = []
  const values: unknown[] = []

  if (workspaceId) {
    values.push(workspaceId)
    conditions.push(`c.workspace_id = $${values.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const res = await pool.query(
      `SELECT
         c.id, c.name, c.workspace_id, c.status,
         w.name AS workspace_name,
         COALESCE(s.sent, 0) AS sent,
         COALESCE(s.opens, 0) AS opens,
         COALESCE(s.replies, 0) AS replies,
         COALESCE(s.bounces, 0) AS bounces,
         CASE WHEN COALESCE(s.sent, 0) > 0 THEN ROUND(s.opens::numeric / s.sent, 4) ELSE 0 END AS open_rate,
         CASE WHEN COALESCE(s.sent, 0) > 0 THEN ROUND(s.replies::numeric / s.sent, 4) ELSE 0 END AS reply_rate,
         CASE WHEN COALESCE(s.sent, 0) > 0 THEN ROUND(s.bounces::numeric / s.sent, 4) ELSE 0 END AS bounce_rate,
         c.created_at, c.updated_at
       FROM campaigns c
       LEFT JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN (
         SELECT campaign_id,
                COUNT(*) FILTER (WHERE event_type = 'sent') AS sent,
                COUNT(*) FILTER (WHERE event_type = 'open') AS opens,
                COUNT(*) FILTER (WHERE event_type = 'reply') AS replies,
                COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounces
         FROM email_events
         GROUP BY campaign_id
       ) s ON s.campaign_id = c.id
       ${where}
       ORDER BY c.created_at DESC`,
      values
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[campaigns]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
