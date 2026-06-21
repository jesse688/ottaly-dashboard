import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Distinct workspace ids present in the contacts table, for the filter dropdown.
// Ported from legacy GET /api/admin/database/workspaces.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT workspace_id AS id, workspace_id AS name
       FROM contacts
       GROUP BY workspace_id
       ORDER BY workspace_id`
    )
    return NextResponse.json({ workspaces: rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[database/workspaces] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
