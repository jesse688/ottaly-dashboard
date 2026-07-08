import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/capacity/pause  { workspace_id, paused: boolean }
//
// Dashboard-only pause for the Capacity page. Marking a client "paused" excludes
// their capacity from the utilisation/wasted TOTALS (so a client deliberately
// not sending doesn't read as wasted resource). It does NOT touch PlusVibe or
// the mailboxes — it's purely a Capacity-view flag, toggleable by CMs.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const workspaceId = String(body.workspace_id || '').trim()
    const paused = body.paused === true
    if (!workspaceId) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })

    // Ensure the table exists (idempotent — safe on every call, cheap).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS capacity_paused_clients (
        workspace_id TEXT PRIMARY KEY,
        paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paused_by TEXT
      )`)

    if (paused) {
      await pool.query(
        `INSERT INTO capacity_paused_clients (workspace_id) VALUES ($1)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId]
      )
    } else {
      await pool.query(`DELETE FROM capacity_paused_clients WHERE workspace_id = $1`, [workspaceId])
    }
    return NextResponse.json({ ok: true, workspace_id: workspaceId, paused })
  } catch (err) {
    console.error('[capacity/pause]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
