import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface InvoiceRow {
  id: string
  invoice_number: string | null
  description: string
  amount: string
  currency: string
  status: string
  due_date: string | null
  paid_date: string | null
  created_at: string
}

interface SummaryRow {
  total_paid: string | null
  total_unpaid: string | null
}

interface DealValueRow {
  total_deal_value: string | null
}

// GET — returns invoices + summary for the logged-in client
export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [invoicesRes, summaryRes, dealRes] = await Promise.all([
    pool.query(
      `SELECT id, invoice_number, description, amount, currency, status, due_date, paid_date, created_at
       FROM portal_invoices
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [session.clientId]
    ),
    pool.query(
      `SELECT
         SUM(amount) FILTER (WHERE status = 'paid')   AS total_paid,
         SUM(amount) FILTER (WHERE status = 'unpaid') AS total_unpaid
       FROM portal_invoices
       WHERE client_id = $1`,
      [session.clientId]
    ),
    pool.query(
      'SELECT SUM(deal_value) AS total_deal_value FROM portal_lead_data WHERE client_id = $1',
      [session.clientId]
    ),
  ])

  const summaryRow = summaryRes.rows[0] as SummaryRow
  const dealRow = dealRes.rows[0] as DealValueRow

  return NextResponse.json({
    invoices: invoicesRes.rows as InvoiceRow[],
    summary: {
      total_paid: Number(summaryRow.total_paid ?? 0),
      total_unpaid: Number(summaryRow.total_unpaid ?? 0),
      total_deal_value: Number(dealRow.total_deal_value ?? 0),
    },
  })
}
