import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         c.id, c.workspace_id, c.name, c.status, c.campaign_type,
         c.lead_count, c.sent_count, c.replied_count, c.bounced_count,
         c.positive_reply_count, c.reply_rate, c.daily_limit,
         c.last_lead_sent, c.last_lead_replied, c.created_at, c.updated_at,
         w.name AS workspace_name,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.replied_count::numeric / c.sent_count, 4)
              ELSE 0 END AS reply_rate_calc,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.bounced_count::numeric / c.sent_count, 4)
              ELSE 0 END AS bounce_rate,
         CASE WHEN c.replied_count > 0
              THEN ROUND(c.positive_reply_count::numeric / c.replied_count, 4)
              ELSE 0 END AS positive_rate,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.lead_count::numeric / c.sent_count, 4)
              ELSE 0 END AS lead_rate
       FROM esp_campaigns c
       LEFT JOIN esp_workspaces w ON w.id = c.workspace_id AND w.source = c.source
       WHERE c.source = 'plusvibe'
       ORDER BY c.last_lead_sent DESC NULLS LAST, c.created_at DESC`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[campaigns]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
