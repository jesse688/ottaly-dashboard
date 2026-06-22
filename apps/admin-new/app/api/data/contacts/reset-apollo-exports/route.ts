import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// Clear all exported_to_apollo_at stamps so every contact shows as not-exported.
// DB-direct port of legacy /contacts/reset-apollo-exports — done in 5k chunks
// with FOR UPDATE SKIP LOCKED so live exports don't deadlock against the
// 200k-row update.
export async function POST(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    const BATCH = 5000
    let cleared = 0
    for (;;) {
      const r = await pool.query(
        `UPDATE contacts SET exported_to_apollo_at = NULL
         WHERE id IN (
           SELECT id FROM contacts
           WHERE workspace_id = $1 AND exported_to_apollo_at IS NOT NULL
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )`,
        [workspaceId, BATCH]
      )
      const n = r.rowCount || 0
      cleared += n
      if (n < BATCH) break
    }
    return NextResponse.json({
      cleared,
      message: `Cleared export stamps from ${cleared} contacts`,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
