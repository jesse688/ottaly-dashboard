import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         h.workspace_id,
         ws.workspace_name,
         h.health_score,
         h.health_band,
         h.sent_7d, h.sent_30d,
         h.replies_7d, h.replies_30d,
         h.leads_7d, h.leads_30d,
         h.reply_rate_7d, h.reply_rate_30d,
         h.bounce_rate_7d,
         h.mailbox_total, h.mailbox_unhealthy,
         h.snapshot_date
       FROM client_health_snapshots h
       LEFT JOIN workspace_stats ws ON ws.workspace_id = h.workspace_id
       WHERE h.snapshot_date = (SELECT MAX(snapshot_date) FROM client_health_snapshots)
       ORDER BY h.health_score ASC NULLS LAST`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[health]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
