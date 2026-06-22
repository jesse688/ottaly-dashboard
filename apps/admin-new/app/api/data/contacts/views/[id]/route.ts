import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// DELETE /api/data/contacts/views/:id — remove a saved view. Port of
// db.deleteSavedView (scoped to the workspace so views can't be cross-deleted).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    const r = await pool.query(
      `DELETE FROM saved_views WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    )
    return NextResponse.json({ deleted: r.rowCount || 0 })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/views] delete', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
