import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { BILLED_SQL } from '@/lib/followups'

// GET /api/admin/followups?view=due|upcoming|done&client=<uuid>
// Only replies Jamie marked FW by hand in the Unibox (unibox_replies.label_type='fw').
//   due      = new / needs_email with due_at <= today (default)
//   upcoming = new with due_at in the future
//   done     = sent / done / dismissed / failed (last 200)
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const view = url.searchParams.get('view') || 'due'
  const client = url.searchParams.get('client')
  const where =
    view === 'upcoming' ? `f.status IN ('new','needs_email') AND f.due_at > CURRENT_DATE AND r.label_type = 'fw' AND NOT ${BILLED_SQL('r')}`
    : view === 'done' ? `f.status IN ('sent','done','dismissed','failed','lead') AND r.label_type = 'fw'`
    : `f.status IN ('new','needs_email') AND (f.due_at IS NULL OR f.due_at <= CURRENT_DATE) AND r.label_type = 'fw' AND NOT ${BILLED_SQL('r')}`
  const params: unknown[] = []
  let clientSql = ''
  if (client) { params.push(client); clientSql = ` AND f.client_id = $${params.length}` }
  const { rows } = await pool.query(
    `SELECT f.*, c.company_name AS client_name,
            r.subject AS reply_subject, r.body_preview AS reply_preview, r.received_at AS reply_received_at,
            COALESCE(NULLIF(r.raw->>'eaccount',''), r.mailbox_email) AS from_mailbox
       FROM followups f
       LEFT JOIN portal_clients c ON c.id = f.client_id
       LEFT JOIN unibox_replies r ON r.id = f.source_reply_id
      WHERE ${where}${clientSql}
      ORDER BY ${view === 'done' ? 'f.updated_at DESC' : 'f.due_at ASC NULLS FIRST, f.created_at ASC'}
      LIMIT 200`,
    params
  )
  const counts = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE f.status IN ('new','needs_email') AND (f.due_at IS NULL OR f.due_at <= CURRENT_DATE)) AS due,
       COUNT(*) FILTER (WHERE f.status IN ('new','needs_email') AND f.due_at > CURRENT_DATE) AS upcoming
     FROM followups f JOIN unibox_replies r ON r.id = f.source_reply_id
     WHERE r.label_type = 'fw' AND NOT ${BILLED_SQL('r')}`
  )
  return NextResponse.json({ rows, counts: counts.rows[0] })
}

// PATCH /api/admin/followups  { id, draft_subject?, draft_body?, target_email?, target_name?, due_at?, status? }
// status may only be set to 'dismissed' or 'done' (a call made by hand) here;
// sending goes through POST /api/admin/followups/[id]/send.
export async function PATCH(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const b = await req.json().catch(() => ({})) as Record<string, string | undefined>
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const sets: string[] = []; const vals: unknown[] = []
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
  if (b.draft_subject !== undefined) set('draft_subject', b.draft_subject)
  if (b.draft_body !== undefined) set('draft_body', b.draft_body)
  if (b.target_name !== undefined) set('target_name', b.target_name)
  if (b.target_email !== undefined) {
    const e = (b.target_email || '').trim().toLowerCase()
    if (e && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return NextResponse.json({ error: 'bad email' }, { status: 400 })
    set('target_email', e || null)
    // An address supplied by hand unblocks a referral.
    if (e) sets.push(`status = CASE WHEN status = 'needs_email' THEN 'new' ELSE status END`)
  }
  if (b.due_at !== undefined) {
    if (b.due_at && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_at)) return NextResponse.json({ error: 'bad date' }, { status: 400 })
    set('due_at', b.due_at || null)
  }
  if (b.status !== undefined) {
    if (!['dismissed', 'done', 'lead'].includes(b.status)) return NextResponse.json({ error: 'bad status' }, { status: 400 })
    set('status', b.status)
    if (b.status_note) set('status_note', b.status_note)
  }
  if (!sets.length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  vals.push(b.id)
  const r = await pool.query(
    `UPDATE followups SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals
  )
  if (!r.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(r.rows[0])
}
