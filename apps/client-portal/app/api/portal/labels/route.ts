import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface LabelRow {
  id: string
  name: string
  color: string
}

// GET — returns client's custom labels
export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await pool.query(
    'SELECT id, name, color FROM portal_client_labels WHERE client_id = $1 ORDER BY created_at ASC',
    [session.clientId]
  )

  return NextResponse.json(res.rows as LabelRow[])
}

// POST — create a custom label
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, color } = await req.json() as { name: string; color: string }
  if (!name || !color) return NextResponse.json({ error: 'name and color are required' }, { status: 400 })

  const res = await pool.query(
    `INSERT INTO portal_client_labels (client_id, name, color)
     VALUES ($1, $2, $3)
     RETURNING id, name, color`,
    [session.clientId, name, color]
  )

  return NextResponse.json(res.rows[0] as LabelRow, { status: 201 })
}
