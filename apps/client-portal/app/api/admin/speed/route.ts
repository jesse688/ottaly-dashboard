import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — Speed to Lead per client: average time from lead reply to client's first
// response, and how many leads it's measured over. Fastest first.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(
    `SELECT pc.id, pc.company_name,
            ROUND(AVG(EXTRACT(EPOCH FROM (ld.first_responded_at - l.first_replied_at))))::int AS avg_secs,
            COUNT(*)::int AS n
       FROM portal_clients pc
       JOIN esp_leads l ON l.workspace_id = pc.workspace_id AND l.source IN ('plusvibe', 'bison')
            AND l.label = 'INTERESTED' AND l.first_replied_at IS NOT NULL
       JOIN portal_lead_data ld ON ld.lead_id = l.id AND ld.client_id = pc.id
            AND ld.first_responded_at IS NOT NULL AND ld.first_responded_at >= l.first_replied_at
      GROUP BY pc.id, pc.company_name
      ORDER BY avg_secs ASC`
  )
  return NextResponse.json({ goalMinutes: 5, rows: r.rows })
}
