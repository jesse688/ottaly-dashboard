import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { addTopup, getBalance } from '@/lib/balance'

// PATCH — confirm or cancel a top-up request.
// Confirming credits the client's ledger by the requested amount.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { action } = await req.json() as { action: 'confirm' | 'cancel' }

  const r = await pool.query(
    `SELECT id, client_id, amount, status FROM portal_topup_requests WHERE id = $1`,
    [id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const req_ = r.rows[0]
  if (req_.status !== 'pending') return NextResponse.json({ error: 'Already resolved' }, { status: 400 })

  if (action === 'confirm') {
    await addTopup(req_.client_id, Number(req_.amount), 'Top-up confirmed')
    await pool.query(
      `UPDATE portal_topup_requests SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [id]
    )
    return NextResponse.json({ ok: true, balance: await getBalance(req_.client_id) })
  }

  await pool.query(`UPDATE portal_topup_requests SET status = 'cancelled' WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
