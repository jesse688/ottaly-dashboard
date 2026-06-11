import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { registerWebhook } from '@/lib/bison'

// POST — (re)register the Bison lead webhook.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const r = await pool.query('SELECT workspace_id FROM portal_clients WHERE id = $1', [id])
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const result = await registerWebhook()
  return NextResponse.json(result)
}
