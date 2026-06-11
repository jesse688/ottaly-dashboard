import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { refundLead } from '@/lib/balance'
import { updateLeadStatus } from '@/lib/plusvibe'

interface DisputeRow {
  id: string
  lead_id: string
  client_id: string
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
    'SELECT id, lead_id, client_id FROM portal_lead_disputes WHERE id = $1',
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
    // Remove from the client's lead view AND refund the lead credit (idempotent).
    await pool.query(
      "UPDATE esp_leads SET label = 'NOT_INTERESTED' WHERE id = $1",
      [dispute.lead_id]
    )
    await refundLead(dispute.client_id, dispute.lead_id)

    // Sync to PlusVibe: NON_LEAD label makes the admin dashboard's revenue
    // logic exclude this lead automatically. Best-effort — surfaced if it fails.
    const lead = await pool.query('SELECT email, workspace_id FROM esp_leads WHERE id = $1', [dispute.lead_id])
    if (lead.rows[0]?.email) {
      const pv = await updateLeadStatus(lead.rows[0].workspace_id, lead.rows[0].email, 'NON_LEAD')
      if (!pv.ok) {
        console.error('[dispute] PV NON_LEAD label failed:', pv.reason)
        return NextResponse.json({ ok: true, pvSynced: false, warning: 'Approved & refunded, but PlusVibe NON_LEAD label failed — mark it in PlusVibe manually so revenue excludes it.' })
      }
      return NextResponse.json({ ok: true, pvSynced: true })
    }
  }

  return NextResponse.json({ ok: true })
}
