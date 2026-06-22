import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// Saved views — named filter sets per workspace. Port of db.listSavedViews /
// saveView (DELETE lives in [id]/route.ts). The `filters` blob is the same
// query string the UI persists, so save/load is symmetric.

export async function GET(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    const r = await pool.query(
      `SELECT id, name, filters, updated_at FROM saved_views
       WHERE workspace_id = $1 ORDER BY LOWER(name)`,
      [workspaceId]
    )
    return NextResponse.json({ views: r.rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/views] list', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body?.name || '').trim()
    const filters = String(body?.filters || '')
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (name.length > 80)
      return NextResponse.json({ error: 'name too long (max 80)' }, { status: 400 })

    const r = await pool.query(
      `INSERT INTO saved_views (workspace_id, name, filters)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         filters = EXCLUDED.filters,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, name, filters, updated_at`,
      [workspaceId, name, filters]
    )
    return NextResponse.json({ view: r.rows[0] })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/views] save', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
