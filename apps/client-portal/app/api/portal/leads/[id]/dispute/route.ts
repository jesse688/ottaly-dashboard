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

const ELIGIBLE_DAYS = 7

// POST — flag a lead. Two types:
//   'non_lead'     — tried, followed up, no response. Effort-gated (must have
//                    replied OR lead is >= ELIGIBLE_DAYS old).
//   'icp_mismatch' — wrong fit, not worth replying. No effort gate.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { type, reason, category } = await req.json() as { type?: string; reason: string; category?: string }
  const dtype = type === 'icp_mismatch' ? 'icp_mismatch' : 'non_lead'
  if (!category) return NextResponse.json({ error: 'Please choose a reason.' }, { status: 400 })
  if (!reason || reason.trim().length < 10) {
    return NextResponse.json({ error: 'Please add a bit of detail (at least 10 characters).' }, { status: 400 })
  }

  // Verify the lead + (for non_lead) check effort eligibility server-side.
  const lead = await pool.query(
    `SELECT l.email,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(l.first_replied_at, l.created_at))) AS age_secs,
            EXISTS (
              SELECT 1 FROM portal_emails e
               WHERE e.workspace_id = l.workspace_id
                 AND lower(e.lead_email) = lower(l.email)
                 AND (e.direction = 'OUT' OR e.sent_via_portal = TRUE)
            ) AS has_replied
       FROM esp_leads l
      WHERE l.id = $1 AND l.workspace_id = $2`,
    [id, session.workspaceId]
  )
  if (!lead.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (dtype === 'non_lead') {
    const ageDays = Number(lead.rows[0].age_secs) / 86400
    const hasReplied = lead.rows[0].has_replied === true
    if (!hasReplied && ageDays < ELIGIBLE_DAYS) {
      return NextResponse.json(
        { error: `Reply and follow up first. You can report a non-lead once you've replied, or after ${ELIGIBLE_DAYS} days of no response. (If the lead simply doesn't fit your criteria, use "Doesn't fit our criteria" instead.)` },
        { status: 403 }
      )
    }
  }

  const res = await pool.query(
    `INSERT INTO portal_lead_disputes (lead_id, client_id, workspace_id, reason, category, dispute_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (lead_id, client_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           category = EXCLUDED.category,
           dispute_type = EXCLUDED.dispute_type,
           status = 'pending',
           admin_note = NULL,
           resolved_at = NULL
     RETURNING *`,
    [id, session.clientId, session.workspaceId, reason.trim(), category, dtype]
  )

  return NextResponse.json(res.rows[0] as DisputeRow)
}
