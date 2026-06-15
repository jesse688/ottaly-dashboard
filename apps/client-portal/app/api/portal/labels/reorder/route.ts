import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// POST { order: string[] } — persist the client's deal-stage order. Sets
// sort_order = index for each owned label. Ignores ids that aren't this client's.
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { order } = await req.json().catch(() => ({})) as { order?: string[] }
  if (!Array.isArray(order)) return NextResponse.json({ error: 'order must be an array' }, { status: 400 })

  for (let i = 0; i < order.length; i++) {
    await pool.query(
      `UPDATE portal_client_labels SET sort_order = $1 WHERE id = $2 AND client_id = $3`,
      [i, order[i], session.clientId]
    )
  }
  return NextResponse.json({ ok: true })
}
