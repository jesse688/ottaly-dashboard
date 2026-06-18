import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Admin dismisses a reply — moves it to the "rejected" folder. Does not touch
// billing or esp_leads. Refuses to reject a reply already marked as a lead.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()
  const { id } = await params

  const r = await pool.query(
    `UPDATE unibox_replies SET folder = 'rejected', updated_at = NOW()
      WHERE id = $1 AND marked_as_lead = FALSE
      RETURNING id`,
    [id]
  )
  if (!r.rows.length) {
    return NextResponse.json({ error: 'Reply not found or already marked as lead' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
