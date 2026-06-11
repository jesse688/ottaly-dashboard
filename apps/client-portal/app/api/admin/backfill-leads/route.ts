import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getWorkspaces } from '@/lib/bison'
import { backfillWorkspace } from '@/lib/sync'
import pool from '@/lib/db'

// Admin-only: backfill ALL clients' workspaces from EmailBison (leads + email threads + charges).
// Idempotent. ?emails=0 skips the slower email pull.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.BISON_API_KEY) {
    return NextResponse.json({ error: 'BISON_API_KEY not configured' }, { status: 500 })
  }
  const withEmails = new URL(req.url).searchParams.get('emails') !== '0'

  try {
    const results = { workspaces: 0, leads: 0, emails: 0, charges: 0, errors: [] as string[] }

    // Get distinct workspace IDs from portal_clients (each may map to a Bison workspace)
    const wsRes = await pool.query(
      `SELECT DISTINCT workspace_id FROM portal_clients WHERE workspace_id IS NOT NULL`
    )
    const workspaceIds: string[] = wsRes.rows.map((r: { workspace_id: string }) => r.workspace_id)

    // Bison returns workspaces from the API key — use those for the workspace name
    const bisonWorkspaces = await getWorkspaces().catch(() => [])
    const wsNames = Object.fromEntries(bisonWorkspaces.map(w => [String(w.id), w.name]))

    // Backfill using each portal workspace_id (or fall back to single-workspace mode)
    const toProcess = workspaceIds.length ? workspaceIds : ['default']
    for (const wsId of toProcess) {
      try {
        const r = await backfillWorkspace(wsId, { withEmails })
        results.workspaces++
        results.leads += r.leads
        results.emails += r.emails
        results.charges += r.charges
      } catch (err) {
        results.errors.push(`Workspace ${wsNames[wsId] ?? wsId}: ${String(err)}`)
      }
    }
    console.log('[backfill] complete:', { ...results, errors: results.errors.length })
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
