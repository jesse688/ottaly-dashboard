import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface DisputeRow {
  id: string
  lead_id: string
  client_id: string
  workspace_id: string
  reason: string
  status: string
  admin_note: string | null
  created_at: string
  resolved_at: string | null
}

// GET — returns existing dispute for this lead+client, or null
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const res = await pool.query(
    'SELECT * FROM portal_lead_disputes WHERE lead_id = $1 AND client_id = $2',
    [id, session.clientId]
  )

  return NextResponse.json(res.rows.length ? (res.rows[0] as DisputeRow) : null)
}

// POST — create or update dispute (upsert)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { reason } = await req.json() as { reason: string }
  if (!reason) return NextResponse.json({ error: 'reason is required' }, { status: 400 })

  const res = await pool.query(
    `INSERT INTO portal_lead_disputes (lead_id, client_id, workspace_id, reason, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (lead_id, client_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           status = 'pending',
           admin_note = NULL,
           resolved_at = NULL
     RETURNING *`,
    [id, session.clientId, session.workspaceId, reason]
  )

  return NextResponse.json(res.rows[0] as DisputeRow)
}
