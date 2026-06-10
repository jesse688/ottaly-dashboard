import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// POST — client requests a balance top-up. Manual-confirm flow: this records a
// pending request and notifies the team. Admin confirms -> credits the ledger.
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { amount, note } = await req.json() as { amount: number; note?: string }
  const amt = Number(amount)
  if (!amt || amt <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const ins = await pool.query(
    `INSERT INTO portal_topup_requests (client_id, amount, note)
     VALUES ($1, $2, $3) RETURNING id`,
    [session.clientId, amt, note ?? null]
  )

  await notifyAdmin({
    clientId: session.clientId,
    kind: 'topup_request',
    title: `Top-up request: ${session.companyName} — £${amt.toLocaleString()}`,
    body: `${session.companyName} requested a £${amt.toLocaleString()} top-up.${note ? `\nNote: ${note}` : ''}\nConfirm in Admin → Top-ups to credit their balance.`,
  })

  return NextResponse.json({ ok: true, id: ins.rows[0].id })
}

// GET — this client's top-up request history
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(
    `SELECT id, amount, status, note, created_at, confirmed_at
       FROM portal_topup_requests WHERE client_id = $1 ORDER BY created_at DESC`,
    [session.clientId]
  )
  return NextResponse.json(r.rows)
}
