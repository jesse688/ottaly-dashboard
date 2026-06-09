import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface InvoiceWithClient {
  id: string
  client_id: string
  company_name: string
  invoice_number: string | null
  description: string
  amount: string
  currency: string
  status: string
  due_date: string | null
  paid_date: string | null
  created_at: string
}

interface InvoiceRow {
  id: string
  client_id: string
  invoice_number: string | null
  description: string
  amount: string
  currency: string
  status: string
  due_date: string | null
  paid_date: string | null
  created_at: string
}

// GET — returns all invoices with client company_name; optional ?clientId= filter
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const clientId = searchParams.get('clientId')

  if (clientId) {
    const res = await pool.query(
      `SELECT i.*, pc.company_name
       FROM portal_invoices i
       JOIN portal_clients pc ON pc.id = i.client_id
       WHERE i.client_id = $1
       ORDER BY i.created_at DESC`,
      [clientId]
    )
    return NextResponse.json(res.rows as InvoiceWithClient[])
  }

  const res = await pool.query(
    `SELECT i.*, pc.company_name
     FROM portal_invoices i
     JOIN portal_clients pc ON pc.id = i.client_id
     ORDER BY i.created_at DESC`
  )

  return NextResponse.json(res.rows as InvoiceWithClient[])
}

// POST — create a new invoice
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    clientId: string
    invoiceNumber?: string
    description: string
    amount: number
    currency?: string
    dueDate?: string
    status?: string
  }

  const { clientId, invoiceNumber, description, amount, currency, dueDate, status } = body

  if (!clientId || !description || amount == null) {
    return NextResponse.json({ error: 'clientId, description, and amount are required' }, { status: 400 })
  }

  const res = await pool.query(
    `INSERT INTO portal_invoices (client_id, invoice_number, description, amount, currency, status, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      clientId,
      invoiceNumber ?? null,
      description,
      amount,
      currency ?? 'GBP',
      status ?? 'unpaid',
      dueDate ?? null,
    ]
  )

  return NextResponse.json(res.rows[0] as InvoiceRow, { status: 201 })
}
