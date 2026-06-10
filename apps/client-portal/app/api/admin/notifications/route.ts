import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — recent admin notifications (top-up requests, replies, invoice-paid pings)
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.is_read, n.created_at, c.company_name
       FROM portal_notifications n
       LEFT JOIN portal_clients c ON c.id = n.client_id
      ORDER BY n.created_at DESC LIMIT 100`
  )
  const unread = await pool.query(`SELECT COUNT(*) FROM portal_notifications WHERE is_read = FALSE`)
  return NextResponse.json({ notifications: r.rows, unread: Number(unread.rows[0].count) })
}

// PATCH — mark all (or one) as read. { id?: string }
export async function PATCH(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await req.json().catch(() => ({ id: undefined })) as { id?: string }
  if (id) await pool.query(`UPDATE portal_notifications SET is_read = TRUE WHERE id = $1`, [id])
  else await pool.query(`UPDATE portal_notifications SET is_read = TRUE WHERE is_read = FALSE`)
  return NextResponse.json({ ok: true })
}
