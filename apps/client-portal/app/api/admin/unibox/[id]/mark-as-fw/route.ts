import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { draftFollowup, FOLLOWUP_MODEL, replyBodyText } from '@/lib/followups'

// Admin marks a Unibox reply as "FW" (follow up): not a lead today, but worth
// working. Puts it straight into the Follow-ups queue (no 1-day wait) with an AI
// draft, and files the reply out of the inbox. Never bills, never touches the ledger.
// Body: { clientId?: string } - same client override the Unibox uses for mark-as-lead.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { clientId?: string }

  const sel = await pool.query(
    `SELECT r.id, r.client_id, r.workspace_id, r.subject, r.body_preview, r.raw, r.received_at, r.marked_as_lead, r.label_type,
            r.lead_email, COALESCE(NULLIF(r.sender_email,''), r.lead_email) AS reply_from
       FROM unibox_replies r WHERE r.id = $1`, [id]
  )
  const r = sel.rows[0]
  if (!r) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
  if (r.marked_as_lead && r.label_type !== 'info') {
    return NextResponse.json({ error: 'Already a billable lead, nothing to follow up.' }, { status: 409 })
  }
  const clientId: string | null = body.clientId || r.client_id
  if (!clientId) return NextResponse.json({ error: 'Pick the client first (reply is unmapped).' }, { status: 409 })
  const c = await pool.query(`SELECT company_name FROM portal_clients WHERE id = $1`, [clientId])

  // Draft with AI; if it can't see a specific action, still queue it (Jamie chose
  // FW on purpose) as a plain follow-up for him to write or tweak.
  let d: Awaited<ReturnType<typeof draftFollowup>> | null = null
  try {
    d = await draftFollowup({
      client: c.rows[0]?.company_name ?? 'the client', subject: r.subject ?? '',
      body: replyBodyText(r.raw, r.body_preview), leadEmail: r.reply_from, receivedAt: new Date(r.received_at),
    })
  } catch (err) {
    console.error('[mark-as-fw] draft failed', id, String(err).slice(0, 200))
  }
  const action = d && d.action_type !== 'none' ? d.action_type : 'recontact_on'
  const due = action === 'recontact_on' && d?.due_date ? d.due_date : new Date().toISOString().slice(0, 10)
  const status = action === 'referral' && !d?.target_email ? 'needs_email' : 'new'

  await pool.query(
    `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, reason, due_at,
                            target_name, target_email, draft_subject, draft_body, confidence, status, status_note, ai_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'marked FW in Unibox',$14)
     ON CONFLICT (source_reply_id) DO UPDATE SET
       client_id = EXCLUDED.client_id, action_type = EXCLUDED.action_type, reason = EXCLUDED.reason,
       due_at = EXCLUDED.due_at, target_name = EXCLUDED.target_name, target_email = EXCLUDED.target_email,
       draft_subject = COALESCE(EXCLUDED.draft_subject, followups.draft_subject),
       draft_body = COALESCE(EXCLUDED.draft_body, followups.draft_body),
       confidence = EXCLUDED.confidence, status = EXCLUDED.status, status_note = EXCLUDED.status_note,
       ai_model = EXCLUDED.ai_model, updated_at = NOW()
     WHERE followups.status NOT IN ('sent','lead')`,
    [r.id, clientId, r.workspace_id, r.reply_from, action,
     d?.reason || 'Marked FW in Unibox', due, d?.target_name || null, d?.target_email || null,
     d?.draft_subject || null, d?.draft_body || null, d?.confidence ?? null, status, FOLLOWUP_MODEL]
  )
  await pool.query(
    `UPDATE unibox_replies SET folder = 'done', label_type = 'fw', updated_at = NOW() WHERE id = $1`, [r.id]
  )
  return NextResponse.json({ ok: true, action, due, status })
}
