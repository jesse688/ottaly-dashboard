import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         ws.workspace_id,
         ws.workspace_name,
         (ws.stats->>'mailbox_count')::int AS mailbox_count,
         (ws.stats->>'avg_daily_per_mailbox')::numeric AS avg_daily_per_mailbox,
         (ws.stats->>'mailbox_monthly_capacity')::int AS monthly_capacity,
         (ws.stats->>'sent_30d')::int AS sent_30d,
         (ws.stats->>'sent_monthly_avg_3mo')::numeric AS avg_monthly_sends,
         (ws.stats->>'contacts_total')::int AS contacts_total,
         (ws.stats->>'client_status')::text AS client_status
       FROM workspace_stats ws
       ORDER BY mailbox_count DESC NULLS LAST`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[capacity]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
