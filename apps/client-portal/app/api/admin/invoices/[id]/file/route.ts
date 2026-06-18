import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { notifyClientOfInvoice } from '@/lib/email'

// GET — download the file attached to an invoice (admin view of the uploaded PDF).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const r = await pool.query(
    `SELECT file_data, file_name, file_mime FROM portal_invoices WHERE id = $1`,
    [id]
  )
  const row = r.rows[0]
  if (!row || !row.file_data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Buffer = row.file_data
  return new NextResponse(new Uint8Array(data), {
    headers: {
      // Whitelisted type + nosniff so an uploaded file can never execute in the portal origin.
      'Content-Type': ['application/pdf', 'image/png', 'image/jpeg'].includes(row.file_mime) ? row.file_mime : 'application/pdf',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${(row.file_name || 'invoice.pdf').replace(/"/g, '')}"`,
    },
  })
}

// POST — attach a PDF (or any file) to an invoice. Stored in-DB (bytea).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })
  const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg']
  if (file.type && !ALLOWED.includes(file.type)) {
    return NextResponse.json({ error: 'Only PDF, PNG or JPEG files are allowed' }, { status: 400 })
  }

  const buf = Buffer.from(await file.arrayBuffer())
  const r = await pool.query(
    `UPDATE portal_invoices SET file_data = $1, file_name = $2, file_mime = $3 WHERE id = $4
     RETURNING client_id, description, amount, currency, status`,
    [buf, file.name, file.type || 'application/pdf', id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Email the client that their invoice (PDF) is ready to pay.
  const inv = r.rows[0]
  if (inv.status === 'unpaid') {
    notifyClientOfInvoice(inv.client_id, { description: inv.description, amount: Number(inv.amount), currency: inv.currency }).catch(() => {})
  }
  return NextResponse.json({ ok: true, file_name: file.name })
}
