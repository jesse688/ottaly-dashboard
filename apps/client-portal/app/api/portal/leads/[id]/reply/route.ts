import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { sendReply } from '@/lib/bison'
import { notifyAdmin } from '@/lib/notify'
import { getLockedLeadIds } from '@/lib/balance'
import { sendEmailReply } from '@/lib/email'

// POST — client replies to a lead.
// 1. Persist the outgoing message to portal_emails (so it shows in the thread immediately)
// 2. Attempt live send via PlusVibe
// 3. Always notify the team (so a reply is never lost, even if live-send isn't wired)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  let body: string, bodyHtml: string | undefined, cc: string | undefined, to: string | undefined
  const attachments: { filename: string; content: Buffer }[] = []

  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const fd = await req.formData()
    body = (fd.get('body') as string | null) ?? ''
    bodyHtml = (fd.get('bodyHtml') as string | null) ?? undefined
    to = (fd.get('to') as string | null) ?? undefined
    cc = (fd.get('cc') as string | null) ?? undefined
    for (const [key, val] of fd.entries()) {
      if (key === 'files' && val instanceof Blob) {
        const blob = val as File
        const buf = Buffer.from(await blob.arrayBuffer())
        attachments.push({ filename: blob.name || 'attachment', content: buf })
      }
    }
  } else {
    const j = await req.json() as { body: string; bodyHtml?: string; cc?: string; to?: string }
    body = j.body; bodyHtml = j.bodyHtml; cc = j.cc; to = j.to
  }

  if (!body?.trim()) return NextResponse.json({ error: 'Empty reply' }, { status: 400 })
  const html = bodyHtml?.trim() ? bodyHtml : `<p>${body.replace(/\n/g, '<br/>')}</p>`

  // Recipients can be separated by comma, space or semicolon.
  const parseAddrs = (s?: string) => (s ?? '').split(/[\s,;]+/).map(x => x.trim()).filter(x => x.includes('@'))

  const leadRes = await pool.query(
    'SELECT id, email, first_name, last_name FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!leadRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const lead = leadRes.rows[0]

  // Can't reply to a locked lead (delivered while out of credit) — top up first.
  const lockedIds = await getLockedLeadIds(session.clientId)
  if (lockedIds.has(id)) return NextResponse.json({ error: 'This lead is locked. Top up to unlock it before replying.' }, { status: 403 })

  // Recipients — default to the lead; client can send/forward to multiple addresses.
  const toAddrs = parseAddrs(to)
  const toList = (toAddrs.length ? toAddrs : [lead.email]).join(', ')
  const ccList = parseAddrs(cc).join(', ')
  const toAddr = toAddrs[0] || lead.email

  // Find the latest inbound message for threading context (subject, Bison reply ID)
  const ctx = await pool.query(
    `SELECT id, subject, eaccount, message_id FROM portal_emails
      WHERE workspace_id = $1 AND lower(lead_email) = lower($2) AND direction = 'IN'
      ORDER BY timestamp_created DESC LIMIT 1`,
    [session.workspaceId, lead.email]
  )
  const subject = ctx.rows[0]?.subject ?? 'Re: your enquiry'
  const eaccount = ctx.rows[0]?.eaccount ?? undefined
  // Bison stores integer reply IDs; portal_emails.id holds the stringified integer.
  const latestReplyId = ctx.rows[0]?.id ? parseInt(ctx.rows[0].id, 10) : null

  // 1. Persist outgoing message (synthetic id so it's stable + idempotent-ish)
  const outId = `portal-${id}-${Date.now()}`
  await pool.query(
    `INSERT INTO portal_emails (
       id, workspace_id, lead_email, direction, subject, body_text, body_html,
       content_preview, from_email, to_email, eaccount, sent_via_portal, timestamp_created
     ) VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,$8,$9,$10,TRUE,NOW())`,
    [
      outId, session.workspaceId, lead.email.toLowerCase(), subject, body,
      html, body.slice(0, 200),
      eaccount ?? session.email, toList, eaccount ?? null,
    ]
  ).catch(err => console.error('[reply] persist failed:', err))

  // 2. Attempt live send.
  // With attachments → Bison doesn't support them, so send directly via Resend.
  // Without attachments → prefer Bison (stays in the same email thread).
  let send: { ok: boolean; reason?: string } = { ok: false, reason: 'no-reply-id-in-cache' }
  if (attachments.length > 0) {
    send = await sendEmailReply({
      to: toList,
      cc: ccList || undefined,
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      html,
      text: body,
      attachments,
    })
    if (!send.ok) console.error('[reply] resend-with-attachments failed:', send.reason)
  } else if (latestReplyId && !isNaN(latestReplyId)) {
    send = await sendReply({
      replyId: latestReplyId,
      bodyText: body,
      bodyHtml: html,
      replyAll: true,
      ccEmails: ccList ? ccList.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    })
  }

  // 3. Notify team (always — guarantees the reply is actioned)
  // Stamp the client's first response time (for Speed to Lead) — once per lead.
  await pool.query(
    `INSERT INTO portal_lead_data (lead_id, client_id, first_responded_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (lead_id, client_id) DO UPDATE
       SET first_responded_at = COALESCE(portal_lead_data.first_responded_at, NOW())`,
    [id, session.clientId]
  ).catch(() => {})

  const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email
  await notifyAdmin({
    clientId: session.clientId,
    kind: 'reply_sent',
    title: `${session.companyName} replied re: ${who}`,
    body: `${send.ok ? '✅ Sent live via EmailBison' : '⚠️ NOT auto-sent (' + send.reason + ') — please send manually'}\nTo: ${toList}${ccList ? `\nCc: ${ccList}` : ''}\nSubject: ${subject}\n\n${body}`,
  })

  return NextResponse.json({ ok: true, sentLive: send.ok })
}
