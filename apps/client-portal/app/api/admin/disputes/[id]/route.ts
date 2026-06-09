import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface DisputeRow {
  id: string
  lead_id: string
}

// PATCH — approve or deny a dispute
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action, note } = await req.json() as { action: 'approved' | 'denied'; note?: string }

  if (action !== 'approved' && action !== 'denied') {
    return NextResponse.json({ error: 'action must be "approved" or "denied"' }, { status: 400 })
  }

  const disputeRes = await pool.query(
    'SELECT id, lead_id FROM portal_lead_disputes WHERE id = $1',
    [id]
  )
  if (!disputeRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const dispute = disputeRes.rows[0] as DisputeRow

  await pool.query(
    `UPDATE portal_lead_disputes
     SET status = $1, admin_note = $2, resolved_at = NOW()
     WHERE id = $3`,
    [action, note ?? null, id]
  )

  if (action === 'approved') {
    await pool.query(
      "UPDATE esp_leads SET label = 'NOT_INTERESTED' WHERE id = $1",
      [dispute.lead_id]
    )
  }

  return NextResponse.json({ ok: true })
}
