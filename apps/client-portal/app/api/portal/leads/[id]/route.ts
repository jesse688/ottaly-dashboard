import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// PATCH — set the client's OWN deal-stage label on a lead.
// This is stored per-client in portal_lead_data.client_label and does NOT touch
// esp_leads.label (our internal "marked as lead" state stays untouched).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { label } = await req.json() as { label: string | null }

  const check = await pool.query(
    'SELECT id FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await pool.query(
    `INSERT INTO portal_lead_data (lead_id, client_id, client_label, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (lead_id, client_id)
     DO UPDATE SET client_label = $3, updated_at = NOW()`,
    [id, session.clientId, label]
  )
  return NextResponse.json({ ok: true })
}
