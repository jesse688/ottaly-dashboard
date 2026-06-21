import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let reason = ''
  try {
    const body = (await req.json()) as { reason?: unknown }
    reason = String(body?.reason ?? '').slice(0, 200)
  } catch {
    // empty body is fine
  }
  try {
    const r = await pool.query(
      `UPDATE health_actions
          SET dismissed_at = CURRENT_TIMESTAMP, dismissed_by = $1, dismissed_reason = $2
        WHERE id = $3 AND completed_at IS NULL AND dismissed_at IS NULL
       RETURNING id`,
      ['Admin', reason || null, id],
    )
    if (!r.rows.length) {
      return NextResponse.json({ error: 'Not found or already actioned' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[health/dismiss]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
