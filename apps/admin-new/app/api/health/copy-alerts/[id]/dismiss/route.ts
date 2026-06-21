import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const r = await pool.query(
      `UPDATE template_alerts
          SET dismissed_at = CURRENT_TIMESTAMP, dismissed_by = $1
        WHERE id = $2 AND dismissed_at IS NULL AND resolved_at IS NULL
       RETURNING id`,
      ['Admin', id],
    )
    if (!r.rows.length) {
      return NextResponse.json({ error: 'Not found or already dismissed' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[health/copy-alert-dismiss]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
