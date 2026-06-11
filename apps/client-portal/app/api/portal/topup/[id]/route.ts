import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// Load a pending request that belongs to this client.
async function loadPending(id: string, clientId: string) {
  const r = await pool.query(
    `SELECT id, amount, status, invoice_id FROM portal_topup_requests WHERE id = $1 AND client_id = $2`,
    [id, clientId]
  )
  return r.rows[0] ?? null
}

// PATCH — edit the amount of a still-pending request (and its draft invoice).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const reqRow = await loadPending(id, session.clientId)
  if (!reqRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (reqRow.status !== 'pending') return NextResponse.json({ error: 'This request has already been processed.' }, { status: 400 })

  const { amount } = await req.json() as { amount: number }
  const amt = Math.floor(Number(amount))
  if (!amt || amt <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const min = Number((await pool.query(`SELECT value FROM portal_settings WHERE key = 'min_topup'`)).rows[0]?.value ?? 10)
  if (amt < min) return NextResponse.json({ error: `The minimum top-up is ${min} leads.` }, { status: 400 })

  await pool.query(`UPDATE portal_topup_requests SET amount = $1 WHERE id = $2`, [amt, id])
  // Keep the linked draft invoice in sync.
  if (reqRow.invoice_id) {
    const cpl = Number((await pool.query('SELECT cost_per_lead FROM portal_clients WHERE id = $1', [session.clientId])).rows[0]?.cost_per_lead ?? 0)
    await pool.query(
      `UPDATE portal_invoices SET amount = $1, description = $2 WHERE id = $3 AND status = 'unpaid'`,
      [amt * cpl, `Lead top-up — ${amt} leads`, reqRow.invoice_id]
    )
  }
  return NextResponse.json({ ok: true })
}

// DELETE — cancel a still-pending request (and void its unpaid invoice).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const reqRow = await loadPending(id, session.clientId)
  if (!reqRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (reqRow.status !== 'pending') return NextResponse.json({ error: 'This request has already been processed.' }, { status: 400 })

  await pool.query(`UPDATE portal_topup_requests SET status = 'cancelled' WHERE id = $1`, [id])
  if (reqRow.invoice_id) {
    await pool.query(`DELETE FROM portal_invoices WHERE id = $1 AND status = 'unpaid'`, [reqRow.invoice_id])
  }
  return NextResponse.json({ ok: true })
}
