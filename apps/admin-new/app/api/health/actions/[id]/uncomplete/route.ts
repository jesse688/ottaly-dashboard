import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const r = await pool.query(
      `UPDATE health_actions
          SET completed_at = NULL, completed_by = NULL, baseline_value = NULL,
              followup_value = NULL, outcome = NULL, outcome_at = NULL, outcome_notes = NULL
        WHERE id = $1 AND completed_at IS NOT NULL
       RETURNING id`,
      [id],
    )
    if (!r.rows.length) {
      return NextResponse.json({ error: 'Not found or not completed' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[health/uncomplete]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
