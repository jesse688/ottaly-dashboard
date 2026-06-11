import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { priceTopup } from '../route'

// PATCH — edit the amount of a still-pending request (and its draft invoice).
// Same pricing + per-client minimum rules as creating one.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const { amount } = await req.json() as { amount: number }
  const amt = Math.floor(Number(amount))
  if (!amt || amt <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const client = await pool.query(
    'SELECT cost_per_lead, currency, topup_buckets, min_topup FROM portal_clients WHERE id = $1',
    [session.clientId]
  )
  const priced = priceTopup(client.rows[0], amt)
  if ('error' in priced) return NextResponse.json({ error: priced.error }, { status: 400 })

  // Guarded transition: only a still-pending request can be edited — a race
  // with admin-confirm loses cleanly (0 rows → 409).
  const upd = await pool.query(
    `UPDATE portal_topup_requests SET amount = $1 WHERE id = $2 AND client_id = $3 AND status = 'pending'
     RETURNING invoice_id`,
    [amt, id, session.clientId]
  )
  if (!upd.rows.length) return NextResponse.json({ error: 'This request has already been processed.' }, { status: 409 })

  if (upd.rows[0].invoice_id) {
    await pool.query(
      `UPDATE portal_invoices SET amount = $1, description = $2 WHERE id = $3 AND status = 'unpaid'`,
      [priced.total, `Lead top-up — ${amt} leads`, upd.rows[0].invoice_id]
    )
  }
  return NextResponse.json({ ok: true })
}

// DELETE — cancel a still-pending request (and void its unpaid invoice).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  // Guarded transition: if the admin confirmed meanwhile this is a clean no-op,
  // so credits and the invoice stay consistent.
  const upd = await pool.query(
    `UPDATE portal_topup_requests SET status = 'cancelled' WHERE id = $1 AND client_id = $2 AND status = 'pending'
     RETURNING invoice_id`,
    [id, session.clientId]
  )
  if (!upd.rows.length) return NextResponse.json({ error: 'This request has already been processed.' }, { status: 409 })

  if (upd.rows[0].invoice_id) {
    await pool.query(`DELETE FROM portal_invoices WHERE id = $1 AND status = 'unpaid'`, [upd.rows[0].invoice_id])
  }
  return NextResponse.json({ ok: true })
}
