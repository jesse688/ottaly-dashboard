import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — download the PDF attached to one of THIS client's invoices.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const r = await pool.query(
    `SELECT file_data, file_name, file_mime FROM portal_invoices WHERE id = $1 AND client_id = $2`,
    [id, session.clientId]
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
