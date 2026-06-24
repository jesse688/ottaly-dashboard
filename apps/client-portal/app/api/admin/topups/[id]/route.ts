import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBalance } from '@/lib/balance'

// PATCH — confirm or cancel a top-up request.
// Confirm = payment received: flips status (guarded — double-click/races lose),
// credits the ledger, and marks the linked invoice paid, in one transaction.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { action } = await req.json() as { action: 'confirm' | 'cancel' }

  if (action === 'confirm') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Conditional flip first — only ONE confirm can ever win.
      const upd = await client.query(
        `UPDATE portal_topup_requests SET status = 'confirmed', confirmed_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING client_id, amount, invoice_id`,
        [id]
      )
      if (!upd.rows.length) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Already resolved' }, { status: 409 })
      }
      const r = upd.rows[0]
      // Resolve the billing redirect IN-TRANSACTION: every balance read/charge path
      // resolves billing_client_id, so the credit must land on that same target —
      // else a redirected client pays but their balance never moves (credit lost on
      // an unread ledger). Mirrors lib/balance.billingClientId.
      const billed = await client.query(
        `SELECT COALESCE(billing_client_id, id) AS target FROM portal_clients WHERE id = $1`,
        [r.client_id]
      )
      const ledgerClientId = billed.rows[0]?.target ?? r.client_id
      await client.query(
        `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
         VALUES ($1, 'topup', $2, 'Top-up confirmed', 'admin')`,
        [ledgerClientId, Math.floor(Number(r.amount))]
      )
      if (r.invoice_id) {
        await client.query(
          `UPDATE portal_invoices SET status = 'paid', paid_date = NOW() WHERE id = $1 AND status = 'unpaid'`,
          [r.invoice_id]
        )
      }
      await client.query('COMMIT')
      return NextResponse.json({ ok: true, balance: await getBalance(r.client_id) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('[topup confirm]', err)
      return NextResponse.json({ error: 'Could not confirm' }, { status: 500 })
    } finally {
      client.release()
    }
  }

  // Cancel: guarded flip + void the unpaid draft invoice.
  const upd = await pool.query(
    `UPDATE portal_topup_requests SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING invoice_id`,
    [id]
  )
  if (!upd.rows.length) return NextResponse.json({ error: 'Already resolved' }, { status: 409 })
  if (upd.rows[0].invoice_id) {
    await pool.query(`DELETE FROM portal_invoices WHERE id = $1 AND status = 'unpaid'`, [upd.rows[0].invoice_id])
  }
  return NextResponse.json({ ok: true })
}
