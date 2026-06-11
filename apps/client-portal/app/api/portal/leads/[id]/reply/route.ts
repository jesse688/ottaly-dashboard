import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { sendReply } from '@/lib/bison'
import { notifyAdmin } from '@/lib/notify'

// POST — client replies to a lead.
// 1. Persist the outgoing message to portal_emails (shows in thread immediately)
// 2. Attempt live send via EmailBison (POST /api/replies/{reply_id}/reply)
// 3. Always notify the team (reply is never lost even if live-send fails)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { body } = await req.json() as { body: string }
  if (!body?.trim()) return NextResponse.json({ error: 'Empty reply' }, { status: 400 })

  const leadRes = await pool.query(
    'SELECT id, email, first_name, last_name FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!leadRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const lead = leadRes.rows[0]

  // Find the latest inbound message ID from Bison (we need the integer reply_id to reply to it)
  const ctx = await pool.query(
    `SELECT id, subject, eaccount, message_id FROM portal_emails
      WHERE workspace_id = $1 AND lower(lead_email) = lower($2) AND direction = 'IN'
      ORDER BY timestamp_created DESC LIMIT 1`,
    [session.workspaceId, lead.email]
  )
  const subject = ctx.rows[0]?.subject ?? 'Re: your enquiry'
  const latestReplyId = ctx.rows[0]?.id ? parseInt(ctx.rows[0].id, 10) : null

  // 1. Persist outgoing message
  const outId = `portal-${id}-${Date.now()}`
  await pool.query(
    `INSERT INTO portal_emails (
       id, workspace_id, lead_email, direction, subject, body_text, body_html,
       content_preview, from_email, to_email, sent_via_portal, timestamp_created
     ) VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,$8,$9,TRUE,NOW())`,
    [
      outId, session.workspaceId, lead.email.toLowerCase(), subject, body,
      `<p>${body.replace(/\n/g, '<br/>')}</p>`, body.slice(0, 200),
      session.email, lead.email,
    ]
  ).catch(err => console.error('[reply] persist failed:', err))

  // 2. Attempt live send via EmailBison
  let send: { ok: boolean; reason?: string } = { ok: false, reason: 'no-reply-id-in-cache' }
  if (latestReplyId && !isNaN(latestReplyId)) {
    send = await sendReply({
      replyId: latestReplyId,
      bodyText: body,
      bodyHtml: `<p>${body.replace(/\n/g, '<br/>')}</p>`,
      replyAll: true,
    })
  }

  // 3. Notify team (always)
  const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email
  await notifyAdmin({
    clientId: session.clientId,
    kind: 'reply_sent',
    title: `${session.companyName} replied to ${who}`,
    body: `${send.ok ? '✅ Sent live via EmailBison' : '⚠️ NOT auto-sent (' + send.reason + ') — please send manually'}\nTo: ${lead.email}\nSubject: ${subject}\n\n${body}`,
  })

  return NextResponse.json({ ok: true, sentLive: send.ok })
}
