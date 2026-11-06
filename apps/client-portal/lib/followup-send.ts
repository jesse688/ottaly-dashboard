import pool from '@/lib/db'
import { sendPlusVibeReply } from '@/lib/plusvibe'
import { isSuppressed, replyBodyText, textToHtml, getThreadState, BILLED_SQL } from '@/lib/followups'

export interface SendResult { ok: boolean; reason?: string; to?: string; from?: string; code: number }

// Send one follow-up from the client's own mailbox via PlusVibe.
//  - recontact_on / send_info / call: reply in the same thread to the person who replied.
//  - referral: a NEW email to the referred person, with the original thread quoted below.
// `fromStatus` is the status we claim from ('new' for Approve & send now,
// 'scheduled' for the cron sending an approved, dated follow-up). Claiming first
// means a double click / overlapping cron can't send twice.
export async function sendFollowup(id: string, approvedBy: string, fromStatus: 'new' | 'scheduled'): Promise<SendResult> {
  const claim = await pool.query(
    `UPDATE followups SET status = 'sending', updated_at = NOW()
      WHERE id = $1 AND status = $2 RETURNING *`, [id, fromStatus]
  )
  const f = claim.rows[0]
  if (!f) return { ok: false, reason: 'not sendable (already sent, dismissed, or needs an email)', code: 409 }

  const fail = async (reason: string, code = 400): Promise<SendResult> => {
    await pool.query(`UPDATE followups SET status = $2, status_note = $3, updated_at = NOW() WHERE id = $1`,
      [id, reason.startsWith('blocked') ? 'dismissed' : 'failed', reason.slice(0, 300)])
    return { ok: false, reason, code }
  }

  if (!f.draft_body?.trim()) return fail('empty draft')

  const src = await pool.query(
    `SELECT workspace_id, subject, body_preview, raw, received_at, lead_email, label_type,
            COALESCE(NULLIF(sender_email,''), lead_email) AS reply_from,
            NULLIF(raw->>'id','') AS pv_id,
            COALESCE(NULLIF(raw->>'eaccount',''), NULLIF(mailbox_email,'')) AS mailbox
       FROM unibox_replies WHERE id = $1`, [f.source_reply_id]
  )
  const r = src.rows[0]
  if (!r) return fail('source reply missing')
  const billed = await pool.query(`SELECT ${BILLED_SQL('u')} AS b FROM unibox_replies u WHERE u.id = $1`, [f.source_reply_id])
  if (billed.rows[0]?.b) return fail('blocked: already a billable lead')
  if (f.action_type !== 'referral' && r.label_type !== 'fw') {
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
    `UPDATE followups SET status = 'sent', sent_at = NOW(), approved_by = COALESCE(approved_by, $2), status_note = NULL, updated_at = NOW() WHERE id = $1`,
    [id, approvedBy]
  )
  return { ok: true, to, from: r.mailbox, code: 200 }
}
