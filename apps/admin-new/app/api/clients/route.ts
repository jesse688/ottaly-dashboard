import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         workspace_id,
         workspace_name,
         stats->>'client_status' AS status,
         (stats->>'mailbox_count')::int AS mailbox_count,
         (stats->>'contacts_total')::int AS contacts_total,
         (stats->>'sent_30d')::int AS sent_30d,
         (stats->>'replied_30d')::int AS replied_30d,
         (stats->>'reply_rate_30d')::numeric AS reply_rate_30d,
         (stats->>'leads_30d')::int AS leads_30d,
         (stats->>'leads_90d')::int AS leads_90d,
         stats->>'last_sent_at' AS last_sent_at,
         stats->>'last_lead_at' AS last_lead_at,
         computed_at
       FROM workspace_stats
       ORDER BY workspace_name`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[clients]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
