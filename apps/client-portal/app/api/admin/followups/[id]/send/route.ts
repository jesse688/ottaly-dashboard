import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { sendPlusVibeReply } from '@/lib/plusvibe'
import { isSuppressed, replyBodyText, textToHtml, getThreadState, BILLED_SQL } from '@/lib/followups'

// POST /api/admin/followups/:id/send  { approved_by?: string }
// Sends the (possibly edited) draft from the client's own mailbox via PlusVibe.
//  - recontact_on / send_info / call: reply in the same thread to the person who replied.
//  - referral: a NEW email to the referred person, with the original thread quoted below.
// Never falls back to an Ottaly mailbox; refuses opted-out recipients.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { approved_by?: string }

  // Claim the row so a double-click can't send twice.
  const claim = await pool.query(
    `UPDATE followups SET status = 'sending', updated_at = NOW()
      WHERE id = $1 AND status = 'new' RETURNING *`, [id]
  )
  const f = claim.rows[0]
  if (!f) return NextResponse.json({ error: 'not sendable (already sent, dismissed, or needs an email)' }, { status: 409 })

  const fail = async (reason: string, code = 400) => {
    await pool.query(`UPDATE followups SET status = $2, status_note = $3, updated_at = NOW() WHERE id = $1`,
      [id, reason.startsWith('blocked') ? 'dismissed' : 'failed', reason.slice(0, 300)])
    return NextResponse.json({ ok: false, reason }, { status: code })
  }

  if (!f.draft_body?.trim()) return fail('empty draft')

  const src = await pool.query(
    `SELECT workspace_id, subject, body_preview, raw, received_at, lead_email,
            COALESCE(NULLIF(sender_email,''), lead_email) AS reply_from,
            NULLIF(raw->>'id','') AS pv_id,
            COALESCE(NULLIF(raw->>'eaccount',''), NULLIF(mailbox_email,'')) AS mailbox
       FROM unibox_replies WHERE id = $1`, [f.source_reply_id]
  )
  const r = src.rows[0]
  if (!r) return fail('source reply missing')
  const billed = await pool.query(`SELECT ${BILLED_SQL('u')} AS b FROM unibox_replies u WHERE u.id = $1`, [f.source_reply_id])
  if (billed.rows[0]?.b) return fail('blocked: already a billable lead')
  if (f.action_type !== 'referral') {
    const t = await getThreadState(r.workspace_id, r.reply_from, r.raw?.thread_id ?? null)
    if (t?.latestType === 'sent' && t.latestAt && new Date(t.latestAt) > new Date(r.received_at)) {
      return fail('blocked: we already replied to this thread in PlusVibe')
    }
  }
  if (!r.mailbox) return fail('no client mailbox to send from')

  const isReferral = f.action_type === 'referral'
  const to: string = isReferral ? f.target_email : r.reply_from
  if (!to) return fail('no recipient address')
  const blocked = await isSuppressed(to)
  if (blocked) return fail(`blocked: ${to} is ${blocked}`)

  let html = textToHtml(f.draft_body)
  if (isReferral) {
    const when = new Date(r.received_at).toUTCString().slice(0, 16)
    const thread = replyBodyText(r.raw, r.body_preview).slice(0, 8000)
    html += `<div><br></div><div>---------- Earlier conversation ----------</div><div>From: ${r.reply_from}<br>Date: ${when}<br>Subject: ${(r.subject ?? '').replace(/</g, '&lt;')}</div><div><br></div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(thread)}</blockquote>`
  }

  const send = await sendPlusVibeReply({
    workspaceId: r.workspace_id,
    replyToId: isReferral ? '' : (r.pv_id && /^[a-f0-9]{16,}$/i.test(r.pv_id) ? r.pv_id : ''),
    subject: f.draft_subject || r.subject || 'Following up',
    from: r.mailbox,
    to,
    body: html,
  })
  if (!send.ok) return fail(`send failed: ${send.reason ?? 'unknown'}`, 502)

  await pool.query(
    `UPDATE followups SET status = 'sent', sent_at = NOW(), approved_by = $2, status_note = NULL, updated_at = NOW() WHERE id = $1`,
    [id, body.approved_by || 'admin']
  )
  return NextResponse.json({ ok: true, to, from: r.mailbox })
}
