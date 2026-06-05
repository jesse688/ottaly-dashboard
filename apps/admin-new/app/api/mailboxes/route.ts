import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         m.id, m.email, m.status, m.warmup_enabled, m.warmup_score,
         m.supplier, m.workspace_id, m.daily_limit, m.sent_today,
         m.tags, m.billing_client, m.last_checked,
         w.name AS workspace_name
       FROM mailboxes m
       LEFT JOIN workspaces w ON w.id = m.workspace_id
       ORDER BY m.status, m.email`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[mailboxes]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
