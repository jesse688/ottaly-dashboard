import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// PATCH — update label on a lead (client can move between stages)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { label } = await req.json() as { label: string }

  // Verify lead belongs to this workspace
  const check = await pool.query(
    'SELECT id FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!check.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await pool.query('UPDATE esp_leads SET label = $1, updated_at = NOW() WHERE id = $2', [label, id])
  return NextResponse.json({ ok: true })
}
