import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// POST — attach a PDF (or any file) to an invoice. Stored in-DB (bytea).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })

  const buf = Buffer.from(await file.arrayBuffer())
  const r = await pool.query(
    `UPDATE portal_invoices SET file_data = $1, file_name = $2, file_mime = $3 WHERE id = $4 RETURNING id`,
    [buf, file.name, file.type || 'application/pdf', id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  return NextResponse.json({ ok: true, file_name: file.name })
}
