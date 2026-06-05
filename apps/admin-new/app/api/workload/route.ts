import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         ws.workspace_id,
         ws.workspace_name,
         (ws.stats->>'client_status') AS status,
         (ws.stats->>'leads_30d')::int AS leads_30d,
         (ws.stats->>'leads_90d')::int AS leads_90d,
         (ws.stats->>'reply_rate_30d')::numeric AS reply_rate_30d,
         (ws.stats->>'mailbox_count')::int AS mailbox_count,
         (ws.stats->>'sent_30d')::int AS sent_30d,
         (ws.stats->>'lpt_30d')::numeric AS lpt_30d,
         (ws.stats->>'lead_target_monthly')::int AS lead_target
       FROM workspace_stats ws
       ORDER BY ws.workspace_name`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[workload]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
