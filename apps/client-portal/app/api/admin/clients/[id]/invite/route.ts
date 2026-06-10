import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, generateInviteToken } from '@/lib/auth'
import pool from '@/lib/db'

// POST — (re)generate a self-service invite link for a client.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const token = generateInviteToken()
  const r = await pool.query(
    `UPDATE portal_clients SET invite_token = $1 WHERE id = $2 RETURNING id`,
    [token, id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true, inviteUrl: `${new URL(req.url).origin}/invite/${token}` })
}
