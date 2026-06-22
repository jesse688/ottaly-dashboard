import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getActiveWorkspaceIds } from '@/lib/active-clients'

interface DomainRow { workspace_id: string | null }

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         domain, workspace_id, workspace_name, score, status,
         spf, dkim, dmarc, mx, blacklists,
         last_checked, notes, ignored_at,
         pm_verified_at
       FROM domain_health
       WHERE ignored_at IS NULL
       ORDER BY score ASC NULLS LAST, domain`
    )
    // Hide inactive clients (fails open). Keep rows with no workspace_id.
    const activeIds = await getActiveWorkspaceIds()
    const rows = activeIds
      ? (res.rows as DomainRow[]).filter(r => !r.workspace_id || activeIds.has(r.workspace_id))
      : res.rows
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[domains]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
