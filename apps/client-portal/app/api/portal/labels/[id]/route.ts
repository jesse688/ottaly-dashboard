import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// DELETE — delete a custom label (ownership verified)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const check = await pool.query(
    'SELECT id FROM portal_client_labels WHERE id = $1 AND client_id = $2',
    [id, session.clientId]
  )
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await pool.query('DELETE FROM portal_client_labels WHERE id = $1', [id])

  return NextResponse.json({ ok: true })
}
