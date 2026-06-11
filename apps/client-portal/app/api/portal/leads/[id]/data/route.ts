import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface LeadDataRow {
  deal_value: string | null
  notes: string | null
  archived?: boolean
  replied_off?: boolean
}

// GET — returns deal_value and notes for this lead+client
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

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
  const body = await req.json() as { deal_value?: string; notes?: string; archived?: boolean; replied_off?: boolean }

  const res = await pool.query(
    `INSERT INTO portal_lead_data (lead_id, client_id, deal_value, notes, archived, replied_off, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, FALSE), COALESCE($6, FALSE), NOW())
     ON CONFLICT (lead_id, client_id) DO UPDATE
       SET deal_value = COALESCE(EXCLUDED.deal_value, portal_lead_data.deal_value),
           notes = COALESCE(EXCLUDED.notes, portal_lead_data.notes),
           archived = COALESCE($5, portal_lead_data.archived),
           replied_off = COALESCE($6, portal_lead_data.replied_off),
           updated_at = NOW()
     RETURNING deal_value, notes, archived, replied_off`,
    [id, session.clientId, body.deal_value ?? null, body.notes ?? null, body.archived ?? null, body.replied_off ?? null]
  )

  const row = res.rows[0] as LeadDataRow
  return NextResponse.json({ deal_value: row.deal_value, notes: row.notes, archived: row.archived, replied_off: row.replied_off })
}
