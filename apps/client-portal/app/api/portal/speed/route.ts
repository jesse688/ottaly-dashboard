import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — Speed to Lead: time from a lead replying (first_replied_at) to the client's
// first response (first_responded_at), per lead + average. Goal is 5 minutes.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const r = await pool.query(
    `SELECT l.id,
            EXTRACT(EPOCH FROM (ld.first_responded_at - l.first_replied_at)) AS secs
       FROM esp_leads l
       JOIN portal_lead_data ld ON ld.lead_id = l.id AND ld.client_id = $1
      WHERE l.workspace_id = $2 AND l.source IN ('plusvibe', 'bison') AND l.label = 'INTERESTED'
        AND l.first_replied_at IS NOT NULL AND ld.first_responded_at IS NOT NULL
        AND ld.first_responded_at >= l.first_replied_at`,
    [session.clientId, session.workspaceId]
  )

  const perLead: Record<string, number> = {}
  const secsList: number[] = []
  for (const row of r.rows) {
    const secs = Math.max(0, Math.round(Number(row.secs)))
    perLead[row.id] = secs
    secsList.push(secs)
  }
  const avgSeconds = secsList.length ? Math.round(secsList.reduce((a, b) => a + b, 0) / secsList.length) : null

  return NextResponse.json({ avgSeconds, count: secsList.length, goalMinutes: 5, perLead })
}
