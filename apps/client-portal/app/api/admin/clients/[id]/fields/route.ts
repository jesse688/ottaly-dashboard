import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface ClientFieldsRow {
  hidden_fields: string[]
}

// GET — returns hidden_fields for a client
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const res = await pool.query(
    'SELECT hidden_fields FROM portal_clients WHERE id = $1',
    [id]
  )
  if (!res.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const row = res.rows[0] as ClientFieldsRow
  return NextResponse.json({ hiddenFields: row.hidden_fields ?? [] })
}

// PATCH — update hidden_fields for a client
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { hiddenFields } = await req.json() as { hiddenFields: string[] }

  if (!Array.isArray(hiddenFields)) {
    return NextResponse.json({ error: 'hiddenFields must be an array' }, { status: 400 })
  }

  const check = await pool.query('SELECT id FROM portal_clients WHERE id = $1', [id])
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await pool.query(
    'UPDATE portal_clients SET hidden_fields = $1 WHERE id = $2',
    [hiddenFields, id]
  )

  return NextResponse.json({ ok: true })
}
