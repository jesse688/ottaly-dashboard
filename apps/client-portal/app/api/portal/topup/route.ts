import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// The minimum custom top-up (leads), set per-client.
function minOf(row: { min_topup?: number | null } | undefined): number {
  const n = Number(row?.min_topup ?? 10)
  return Number.isFinite(n) && n > 0 ? n : 10
}

interface ClientPricingRow {
  cost_per_lead?: number | string | null
  currency?: string | null
  topup_buckets?: { leads: number; pricePerLead: number }[] | null
  min_topup?: number | null
}

// One pricing rule for create AND edit: bucket amounts use the bucket's price,
// custom amounts must clear the per-client minimum and use cost_per_lead.
export function priceTopup(row: ClientPricingRow | undefined, amt: number):
  { pricePerLead: number; total: number; currency: string } | { error: string } {
  const buckets = Array.isArray(row?.topup_buckets) ? row.topup_buckets : []
  const bucket = buckets.find(b => Number(b.leads) === amt)
  if (!bucket && amt < minOf(row)) return { error: `The minimum top-up is ${minOf(row)} leads.` }
  const pricePerLead = bucket ? Number(bucket.pricePerLead) : Number(row?.cost_per_lead ?? 0)
  if (!Number.isFinite(pricePerLead) || pricePerLead < 0) return { error: 'Pricing is not configured for this amount — contact us.' }
  return { pricePerLead, total: amt * pricePerLead, currency: row?.currency ?? 'GBP' }
}

// POST — client requests a balance top-up. Enforces the minimum, records a
// pending request, and generates a draft invoice. Admin confirms -> credits leads.
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { amount, note } = await req.json() as { amount: number; note?: string }
  const amt = Math.floor(Number(amount))
  if (!amt || amt <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const client = await pool.query('SELECT cost_per_lead, currency, topup_buckets, min_topup FROM portal_clients WHERE id = $1', [session.clientId])
  const priced = priceTopup(client.rows[0], amt)
  if ('error' in priced) return NextResponse.json({ error: priced.error }, { status: 400 })
  const currency = priced.currency
  const invoiceAmount = priced.total

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
  const [reqs, client] = await Promise.all([
    pool.query(
      `SELECT id, amount, status, note, invoice_id, created_at, confirmed_at
         FROM portal_topup_requests WHERE client_id = $1 ORDER BY created_at DESC`,
      [session.clientId]
    ),
    pool.query('SELECT topup_buckets, currency, min_topup FROM portal_clients WHERE id = $1', [session.clientId]),
  ])
  const buckets = Array.isArray(client.rows[0]?.topup_buckets) ? client.rows[0].topup_buckets : []
  return NextResponse.json({ requests: reqs.rows, minTopup: minOf(client.rows[0]), buckets, currency: client.rows[0]?.currency ?? 'GBP' })
}
