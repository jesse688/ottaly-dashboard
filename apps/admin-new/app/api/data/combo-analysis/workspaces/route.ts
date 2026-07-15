import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Client list for the Combo Analysis scope dropdown: workspace_id + human name.
// Lists ALL workspaces from workspace_stats (not just those with email_events
// send history — that filter hid workspaces that are actually sending, because
// email_events is webhook-partial). Combo data now comes from combo_daily_stats,
// which is populated per-workspace by the warmer regardless of email_events.
export async function GET() {
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT workspace_id AS id,
              COALESCE(NULLIF(workspace_name, ''), workspace_id) AS name
         FROM workspace_stats
        WHERE workspace_id IS NOT NULL AND workspace_id <> ''
        ORDER BY name`
    )
    return NextResponse.json({ workspaces: rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[combo-analysis/workspaces] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
