import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Workspace list for the ESP Matching page. Unlike the Combo Analysis dropdown
// (which only offers workspaces with send history in email_events), ESP matching
// applies to ANY workspace, so this returns them all from workspace_stats.
export async function GET() {
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT workspace_id AS id,
              COALESCE(NULLIF(workspace_name, ''), workspace_id) AS name
         FROM workspace_stats
        WHERE workspace_id IS NOT NULL AND workspace_id <> ''
        ORDER BY name`,
    )
    return NextResponse.json({ workspaces: rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
