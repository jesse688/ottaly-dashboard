import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

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

// PATCH — update an invoice
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json() as {
    status?: string
    paidDate?: string | null
    amount?: number
    description?: string
    dueDate?: string | null
  }

  const check = await pool.query('SELECT id FROM portal_invoices WHERE id = $1', [id])
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = await pool.query(
    `UPDATE portal_invoices SET
       status      = COALESCE($1, status),
       paid_date   = CASE WHEN $2::text IS DISTINCT FROM 'UNCHANGED' THEN $2::date ELSE paid_date END,
       amount      = COALESCE($3, amount),
       description = COALESCE($4, description),
       due_date    = CASE WHEN $5::text IS DISTINCT FROM 'UNCHANGED' THEN $5::date ELSE due_date END
     WHERE id = $6
     RETURNING *`,
    [
      body.status ?? null,
      body.paidDate !== undefined ? (body.paidDate ?? null) : 'UNCHANGED',
      body.amount ?? null,
      body.description ?? null,
      body.dueDate !== undefined ? (body.dueDate ?? null) : 'UNCHANGED',
      id,
    ]
  )

  return NextResponse.json(res.rows[0] as InvoiceRow)
}

// DELETE — remove an invoice
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const check = await pool.query('SELECT id FROM portal_invoices WHERE id = $1', [id])
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await pool.query('DELETE FROM portal_invoices WHERE id = $1', [id])

  return NextResponse.json({ ok: true })
}
