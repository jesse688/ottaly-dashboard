import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

const CATEGORIES = ['interested', 'not_interested', 'ooo_auto_reply', 'question', 'unsubscribe', 'other']

// Admin overrides Claude's classification by setting admin_label. Stored
// alongside (not over) the AI category so we keep the model's original call.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()
  const { id } = await params

  const body = await req.json().catch(() => ({})) as { admin_label?: string }
  const adminLabel = body.admin_label
  if (typeof adminLabel !== 'string' || !CATEGORIES.includes(adminLabel)) {
    return NextResponse.json({ error: `admin_label must be one of: ${CATEGORIES.join(', ')}` }, { status: 400 })
  }

  const r = await pool.query(
    `UPDATE unibox_replies
        SET admin_label = $2, admin_label_by = 'admin', updated_at = NOW()
      WHERE id = $1
      RETURNING id, admin_label`,
    [id, adminLabel]
  )
  if (!r.rows.length) {
    return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, admin_label: r.rows[0].admin_label })
}
