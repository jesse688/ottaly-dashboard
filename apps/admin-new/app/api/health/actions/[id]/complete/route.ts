import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Snapshot columns an action may name as its target metric. Whitelist
// guards the dynamic column read below (no user-controlled SQL).
const METRIC_COLUMNS = new Set([
  'health_score', 'reply_rate_7d', 'reply_rate_30d', 'bounce_rate_7d',
  'sent_7d', 'replies_7d', 'leads_7d', 'mailbox_unhealthy',
])

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const aRes = await pool.query<{
      workspace_id: string
      target_metric: string | null
    }>(
      `SELECT workspace_id, target_metric FROM health_actions
        WHERE id = $1 AND completed_at IS NULL AND dismissed_at IS NULL LIMIT 1`,
      [id],
    )
    const act = aRes.rows[0]
    if (!act) {
      return NextResponse.json(
        { error: 'Action not found or already actioned' },
        { status: 404 },
      )
    }

    let baseline: number | null = null
    if (act.target_metric && METRIC_COLUMNS.has(act.target_metric)) {
      const sRes = await pool.query<{ v: number | null }>(
        `SELECT ${act.target_metric} AS v FROM client_health_snapshots
          WHERE workspace_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
        [act.workspace_id],
      )
      baseline = sRes.rows[0]?.v ?? null
    }

    await pool.query(
      `UPDATE health_actions
          SET completed_at = CURRENT_TIMESTAMP, completed_by = $1, baseline_value = $2
        WHERE id = $3`,
      ['Admin', baseline, id],
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[health/complete]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
