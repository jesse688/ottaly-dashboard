import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspace_id')
  const values: unknown[] = []
  const conditions: string[] = ["label NOT IN ('UNSUBSCRIBED','BOUNCED')"]
  if (workspaceId) { values.push(workspaceId); conditions.push(`workspace_id = $${values.length}`) }

  try {
    const res = await pool.query(
      `SELECT workspace_id, workspace_name, lead_email, first_name, last_name,
              campaign, lead_price, date, label, updated_at
       FROM revenue_leads
       WHERE ${conditions.join(' AND ')}
       ORDER BY date DESC
       LIMIT 1000`,
      values
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[leads-analysis]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
