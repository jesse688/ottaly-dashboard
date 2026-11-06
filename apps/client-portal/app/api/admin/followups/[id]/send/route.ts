import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { sendFollowup } from '@/lib/followup-send'

// POST /api/admin/followups/:id/send
//   { approved_by?: string }                       -> send now
//   { approved_by?: string, send_on: 'YYYY-MM-DD' } -> approve now, send on that date
//      (the followups cron sends scheduled rows once the date arrives, re-checking
//       billing / opt-outs / already-replied at send time)
//   { cancel_schedule: true }                      -> back to an open card
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { approved_by?: string; send_on?: string; cancel_schedule?: boolean }

  if (body.cancel_schedule) {
    const r = await pool.query(
      `UPDATE followups SET status = 'new', scheduled_for = NULL, updated_at = NOW() WHERE id = $1 AND status = 'scheduled' RETURNING id`, [id])
    return r.rowCount ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not scheduled' }, { status: 409 })
  }

  if (body.send_on) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.send_on)) return NextResponse.json({ error: 'bad date' }, { status: 400 })
    const today = new Date().toISOString().slice(0, 10)
    if (body.send_on > today) {
      const r = await pool.query(
        `UPDATE followups SET status = 'scheduled', scheduled_for = $2, due_at = $2, approved_by = $3, updated_at = NOW()
          WHERE id = $1 AND status = 'new' AND COALESCE(draft_body,'') <> '' RETURNING id`,
        [id, body.send_on, body.approved_by || 'admin'])
      if (!r.rowCount) return NextResponse.json({ error: 'not schedulable (empty draft, needs an email, or already handled)' }, { status: 409 })
      return NextResponse.json({ ok: true, scheduled_for: body.send_on })
    }
    // today or earlier = send now
  }

  const res = await sendFollowup(id, body.approved_by || 'admin', 'new')
  return res.ok
    ? NextResponse.json({ ok: true, to: res.to, from: res.from })
    : NextResponse.json({ ok: false, reason: res.reason }, { status: res.code })
}
