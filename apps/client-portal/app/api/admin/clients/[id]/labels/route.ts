import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — returns all labels for the client's workspace + which are hidden
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const clientRes = await pool.query(
    'SELECT workspace_id, hidden_labels FROM portal_clients WHERE id = $1',
    [id]
  )
  if (!clientRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { workspace_id, hidden_labels } = clientRes.rows[0] as {
    workspace_id: string
    hidden_labels: string[]
  }

  const labelsRes = await pool.query(
    `SELECT DISTINCT label, COUNT(*) AS count
     FROM esp_leads
     WHERE workspace_id = $1 AND source IN ('plusvibe', 'bison') AND label IS NOT NULL
     GROUP BY label ORDER BY count DESC`,
    [workspace_id]
  )

  return NextResponse.json({
    labels: labelsRes.rows,
    hiddenLabels: hidden_labels ?? [],
  })
}

// PATCH — update hidden_labels for the client
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { hiddenLabels } = await req.json() as { hiddenLabels: string[] }

  await pool.query(
    'UPDATE portal_clients SET hidden_labels = $1 WHERE id = $2',
    [hiddenLabels, id]
  )
  return NextResponse.json({ ok: true })
}
