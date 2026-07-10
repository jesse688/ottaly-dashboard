import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Client list for the Combo Analysis scope dropdown: workspace_id + human name.
// Names come from workspace_stats (same source /triage uses); only workspaces
// that actually appear in email_events are offered, so the dropdown never lists
// clients with no send data to analyse.
export async function GET() {
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT ws.workspace_id AS id,
              COALESCE(NULLIF(ws.workspace_name, ''), ws.workspace_id) AS name
         FROM workspace_stats ws
        WHERE EXISTS (
                SELECT 1 FROM email_events ee
                 WHERE ee.workspace_id = ws.workspace_id
                   AND ee.event_type = 'sent'
              )
        ORDER BY name`
    )
    return NextResponse.json({ workspaces: rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[combo-analysis/workspaces] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
