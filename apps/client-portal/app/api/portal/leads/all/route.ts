import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await pool.query(
      `SELECT l.id, l.email, l.first_name, l.last_name, l.company_name,
              l.status, l.label, l.first_replied_at,
              c.name AS campaign_name
       FROM esp_leads l
       LEFT JOIN esp_campaigns c ON c.id = l.campaign_id AND c.source = 'plusvibe'
       WHERE l.workspace_id = $1
         AND l.source = 'plusvibe'
         AND l.status IN ('INTERESTED', 'MEETING_BOOKED')
       ORDER BY l.first_replied_at DESC NULLS LAST, l.created_at DESC`,
      [session.workspaceId]
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[portal/leads/all]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
