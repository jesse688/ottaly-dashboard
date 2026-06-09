import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await pool.query(
      `SELECT
         c.id, c.name, c.status, c.lead_count, c.sent_count,
         c.replied_count, c.bounced_count, c.positive_reply_count,
         c.daily_limit, c.last_lead_sent, c.created_at,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.replied_count::numeric / c.sent_count, 4)
              ELSE 0 END AS reply_rate,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.bounced_count::numeric / c.sent_count, 4)
              ELSE 0 END AS bounce_rate
       FROM esp_campaigns c
       WHERE c.workspace_id = $1 AND c.source = 'plusvibe'
       ORDER BY c.last_lead_sent DESC NULLS LAST, c.created_at DESC`,
      [session.workspaceId]
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[portal/campaigns]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
