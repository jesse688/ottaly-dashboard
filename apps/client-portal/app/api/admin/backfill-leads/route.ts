import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { backfillWorkspace } from '@/lib/sync'

// Admin-only: backfill ALL clients' leads from Bison (leads + real emails + charges).
// Iterates portal_clients (PV workspace_ids) — NOT Bison /api/workspaces, which
// only returns the token's own team. backfillWorkspace switches to each client's
// Bison team and syncs leads tagged "lead". Idempotent. ?emails=0 skips emails.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.BISON_API_KEY && !process.env.PLUSVIBE_API_KEY && !process.env.PLUSVIBE_KEY) {
    return NextResponse.json({ error: 'BISON_API_KEY not configured' }, { status: 500 })
  }
  const withEmails = new URL(req.url).searchParams.get('emails') !== '0'

  try {
    const results = { workspaces: 0, leads: 0, emails: 0, charges: 0, errors: [] as string[] }
    const { rows } = await pool.query(
      `SELECT DISTINCT workspace_id, company_name FROM portal_clients
        WHERE workspace_id IS NOT NULL AND workspace_id != ''`
    )
    console.log(`[backfill] starting for ${rows.length} client workspace(s)`)
    for (const c of rows) {
      try {
        const r = await backfillWorkspace(String(c.workspace_id), { withEmails })
        results.workspaces++; results.leads += r.leads; results.emails += r.emails; results.charges += r.charges
        console.log(`[backfill] ${c.company_name ?? c.workspace_id}: ${r.leads} lead(s)`)
      } catch (err) {
        results.errors.push(`${c.company_name ?? c.workspace_id}: ${String(err)}`)
      }
    }
    console.log('[backfill] complete:', { ...results, errors: results.errors.length })
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
