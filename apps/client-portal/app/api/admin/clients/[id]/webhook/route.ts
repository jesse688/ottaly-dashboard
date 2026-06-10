import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { registerWebhook } from '@/lib/plusvibe'

// POST — (re)register the PlusVibe lead webhook for this client's workspace.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const r = await pool.query('SELECT workspace_id FROM portal_clients WHERE id = $1', [id])
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const result = await registerWebhook(r.rows[0].workspace_id)
  return NextResponse.json(result)
}
