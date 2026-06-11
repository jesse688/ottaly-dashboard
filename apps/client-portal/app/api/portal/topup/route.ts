import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// The minimum top-up (number of leads), set globally by admin.
async function getMinTopup(): Promise<number> {
  const r = await pool.query(`SELECT value FROM portal_settings WHERE key = 'min_topup'`)
  const n = Number(r.rows[0]?.value ?? 10)
  return Number.isFinite(n) && n > 0 ? n : 10
}

// POST — client requests a balance top-up. Enforces the minimum, records a
// pending request, and generates a draft invoice. Admin confirms -> credits leads.
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { amount, note } = await req.json() as { amount: number; note?: string }
  const amt = Math.floor(Number(amount))
  if (!amt || amt <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const min = await getMinTopup()
  if (amt < min) return NextResponse.json({ error: `The minimum top-up is ${min} leads.` }, { status: 400 })

  const client = await pool.query('SELECT cost_per_lead, currency FROM portal_clients WHERE id = $1', [session.clientId])
  const costPerLead = Number(client.rows[0]?.cost_per_lead ?? 0)
  const currency = client.rows[0]?.currency ?? 'GBP'
  const invoiceAmount = amt * costPerLead

  // Draft invoice for the requested leads (so the client has something to pay).
  const inv = await pool.query(
    `INSERT INTO portal_invoices (client_id, description, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'unpaid') RETURNING id`,
    [session.clientId, `Lead top-up — ${amt} leads`, invoiceAmount, currency]
  )

  const ins = await pool.query(
    `INSERT INTO portal_topup_requests (client_id, amount, note, invoice_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [session.clientId, amt, note ?? null, inv.rows[0].id]
  )

  await notifyAdmin({
    clientId: session.clientId,
    kind: 'topup_request',
    title: `Top-up request: ${session.companyName} — ${amt} leads`,
    body: `${session.companyName} requested ${amt} leads.${note ? `\nNote: ${note}` : ''}\nConfirm in Admin → Top-ups to credit their balance.`,
  })

  return NextResponse.json({ ok: true, id: ins.rows[0].id })
}

// GET — this client's top-up request history + the current minimum.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [reqs, min] = await Promise.all([
    pool.query(
      `SELECT id, amount, status, note, invoice_id, created_at, confirmed_at
         FROM portal_topup_requests WHERE client_id = $1 ORDER BY created_at DESC`,
      [session.clientId]
    ),
    getMinTopup(),
  ])
  return NextResponse.json({ requests: reqs.rows, minTopup: min })
}
