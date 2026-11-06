import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { draftFollowup, FOLLOWUP_MODEL, replyBodyText } from '@/lib/followups'

// POST /api/admin/followups/:id/redraft - ask the AI for a fresh draft (always
// produces one; the card was chosen by an admin so 'none' isn't an option).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const q = await pool.query(
    `SELECT f.id, f.status, f.target_email, r.subject, r.body_preview, r.raw, r.received_at,
            COALESCE(NULLIF(r.sender_email,''), r.lead_email) AS reply_from, c.company_name
       FROM followups f JOIN unibox_replies r ON r.id = f.source_reply_id
       LEFT JOIN portal_clients c ON c.id = f.client_id
      WHERE f.id = $1`, [id])
  const f = q.rows[0]
  if (!f) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!['new', 'needs_email', 'scheduled'].includes(f.status)) return NextResponse.json({ error: 'already handled' }, { status: 409 })
  let d
  try {
    d = await draftFollowup({
      client: f.company_name ?? 'the client', subject: f.subject ?? '', body: replyBodyText(f.raw, f.body_preview),
      leadEmail: f.reply_from, receivedAt: new Date(f.received_at), forced: true,
    })
  } catch (err) {
    return NextResponse.json({ error: `AI draft failed: ${String(err).slice(0, 150)}` }, { status: 502 })
  }
  const action = d.action_type === 'none' ? 'recontact_on' : d.action_type
  const r = await pool.query(
    `UPDATE followups SET action_type = $2, reason = COALESCE(NULLIF($3,''), reason),
            draft_subject = $4, draft_body = $5,
            target_name = COALESCE(NULLIF($6,''), target_name), target_email = COALESCE(NULLIF($7,''), target_email),
            suggested_on = CASE WHEN $8 <> '' AND $8::date > CURRENT_DATE THEN $8::date ELSE suggested_on END,
            confidence = $9, ai_model = $10, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, action, d.reason, d.draft_subject, d.draft_body, d.target_name, d.target_email, d.due_date, d.confidence, FOLLOWUP_MODEL])
  return NextResponse.json(r.rows[0])
}
