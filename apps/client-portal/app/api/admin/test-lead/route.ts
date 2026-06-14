import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// Inject a fake lead into a client's portal so new features can be tested without
// waiting for a real prospect. Creates an INTERESTED esp_leads row with
// first_replied_at = now (so the Speed-to-Lead timer ticks live) + a portal_emails
// thread containing a realistic signature (so thread display + signature
// extraction work). All test rows are tagged id 'test_*' for easy cleanup.

const SAMPLE = {
  first_name: 'Test', last_name: 'Prospect',
  company: 'Demo Co Ltd',
  email: 'test.prospect@demo-co.example',
  subject: 'Re: Quick question about your services',
  body_html: `<p>Hi there,</p>
<p>Thanks for reaching out — this sounds genuinely interesting and the timing is good for us. Could you send over a bit more detail on pricing and how quickly we could get started?</p>
<p>Best,<br>Test Prospect</p>
<p>Managing Director</p>
<p>M: 07700 900123<br>W: https://demo-co.example<br>https://www.linkedin.com/in/test-prospect</p>`,
  body_text: `Hi there,

Thanks for reaching out — this sounds genuinely interesting and the timing is good for us. Could you send over a bit more detail on pricing and how quickly we could get started?

Best,
Test Prospect

Managing Director

M: 07700 900123
W: https://demo-co.example
https://www.linkedin.com/in/test-prospect`,
}

// POST { workspaceId, email? } — create a test lead in that workspace.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { workspaceId?: string; email?: string }
  const workspaceId = (body.workspaceId ?? '').trim()
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  // Unique-ish per click so you can make several; timestamp passed from client to
  // avoid Date.now() restrictions isn't needed here (route runs server-side).
  const stamp = Date.now()
  const email = (body.email ?? `test+${stamp}@demo-co.example`).toLowerCase()
  const leadId = `test_${stamp}`

  await pool.query(
    `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, first_replied_at, created_at, updated_at)
     VALUES ($1,$2,NULL,'plusvibe',$3,$4,$5,$6,'INTERESTED','INTERESTED',NOW(),NOW(),NOW())
     ON CONFLICT (id, source) DO NOTHING`,
    [leadId, workspaceId, email, SAMPLE.first_name, SAMPLE.last_name, SAMPLE.company]
  )

  // An inbound message so the thread + Speed-to-Lead + signature extraction work.
  await pool.query(
    `INSERT INTO portal_emails (
       id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
       subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
       pv_label, is_unread, message_id, timestamp_created, raw
     ) VALUES ($1,$2,$3,$4,$5,NULL,'IN',$6,$7,$8,$9,$10,NULL,NULL,'INTERESTED',1,$11,NOW(),'{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      `testmsg_${stamp}`, workspaceId, leadId, email, `testthread_${stamp}`,
      SAMPLE.subject, SAMPLE.body_html, SAMPLE.body_text, SAMPLE.body_text.slice(0, 200),
      email, `testmsg_${stamp}@demo-co.example`,
    ]
  )

  return NextResponse.json({ ok: true, leadId, email, message: 'Test lead created — open the client portal (View as) to see it.' })
}

// DELETE { workspaceId? } — remove ALL test leads (and their emails). Scoped to a
// workspace if given, else everywhere. Only touches the test_* / testmsg_* rows.
export async function DELETE(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { workspaceId?: string }
  const ws = (body.workspaceId ?? '').trim()

  const emailWhere = ws ? `AND workspace_id = $1` : ''
  const leadWhere = ws ? `AND workspace_id = $1` : ''
  const args = ws ? [ws] : []

  const e = await pool.query(`DELETE FROM portal_emails WHERE id LIKE 'testmsg_%' ${emailWhere}`, args)
  const l = await pool.query(`DELETE FROM esp_leads WHERE id LIKE 'test\\_%' ${leadWhere}`, args)
  return NextResponse.json({ ok: true, leadsRemoved: l.rowCount ?? 0, emailsRemoved: e.rowCount ?? 0 })
}
