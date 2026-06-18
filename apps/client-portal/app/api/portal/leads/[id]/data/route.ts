import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface LeadDataRow {
  deal_value: string | null
  notes: string | null
  archived?: boolean
  replied_off?: boolean
}

// Confirm the lead actually belongs to this client's workspace before reading or
// writing its data — same ownership guard the thread/reply/dispute routes use.
async function ownsLead(leadId: string, workspaceId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM esp_leads WHERE id = $1 AND workspace_id = $2 LIMIT 1', [leadId, workspaceId])
  return r.rows.length > 0
}

// GET — returns deal_value and notes for this lead+client
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!await ownsLead(id, session.workspaceId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = await pool.query(
    'SELECT deal_value, notes FROM portal_lead_data WHERE lead_id = $1 AND client_id = $2',
    [id, session.clientId]
  )

  if (!res.rows.length) return NextResponse.json({ deal_value: null, notes: null })

  const row = res.rows[0] as LeadDataRow
  return NextResponse.json({ deal_value: row.deal_value, notes: row.notes })
}

// PATCH — upsert deal_value and/or notes
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!await ownsLead(id, session.workspaceId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json() as { deal_value?: string; notes?: string; archived?: boolean; replied_off?: boolean }

  // Marking 'replied off-dashboard' also counts as the first response (Speed to Lead).
  const respondedAt = body.replied_off === true ? 'NOW()' : 'NULL'
  const res = await pool.query(
    `INSERT INTO portal_lead_data (lead_id, client_id, deal_value, notes, archived, replied_off, first_responded_at, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, FALSE), COALESCE($6, FALSE), ${respondedAt}, NOW())
     ON CONFLICT (lead_id, client_id) DO UPDATE
       SET deal_value = COALESCE(EXCLUDED.deal_value, portal_lead_data.deal_value),
           notes = COALESCE(EXCLUDED.notes, portal_lead_data.notes),
           archived = COALESCE($5, portal_lead_data.archived),
           replied_off = COALESCE($6, portal_lead_data.replied_off),
           first_responded_at = COALESCE(portal_lead_data.first_responded_at, ${respondedAt}),
           updated_at = NOW()
     RETURNING deal_value, notes, archived, replied_off`,
    [id, session.clientId, body.deal_value ?? null, body.notes ?? null, body.archived ?? null, body.replied_off ?? null]
  )

  const row = res.rows[0] as LeadDataRow
  return NextResponse.json({ deal_value: row.deal_value, notes: row.notes, archived: row.archived, replied_off: row.replied_off })
}
