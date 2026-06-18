import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// POST — client marks an invoice as paid (manual flow): notifies the team.
// Admin confirms in the admin portal which sets status='paid'.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const r = await pool.query(
    `SELECT invoice_number, amount, currency FROM portal_invoices WHERE id = $1 AND client_id = $2`,
    [id, session.clientId]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const inv = r.rows[0]

  await notifyAdmin({
    clientId: session.clientId,
    kind: 'invoice_paid',
    title: `${session.companyName} marked invoice ${inv.invoice_number ?? ''} as paid`,
    body: `Amount: £${Number(inv.amount).toLocaleString()}\nConfirm in Admin → Invoices to set it paid.`,
  })
  return NextResponse.json({ ok: true })
}
