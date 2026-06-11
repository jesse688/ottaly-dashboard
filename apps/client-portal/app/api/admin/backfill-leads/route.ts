import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getWorkspaces } from '@/lib/plusvibe'
import { backfillWorkspace } from '@/lib/sync'

// Admin-only: backfill ALL workspaces from PlusVibe (leads + real emails + charges).
// Idempotent. ?emails=0 skips the slower email pull.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.BISON_API_KEY && !process.env.PLUSVIBE_API_KEY && !process.env.PLUSVIBE_KEY) {
    return NextResponse.json({ error: 'BISON_API_KEY not configured' }, { status: 500 })
  }
  const withEmails = new URL(req.url).searchParams.get('emails') !== '0'

  try {
    const results = { workspaces: 0, leads: 0, emails: 0, charges: 0, errors: [] as string[] }
    const workspaces = await getWorkspaces()
    for (const ws of workspaces) {
      try {
        const r = await backfillWorkspace(String(ws.id), { withEmails })
        results.workspaces++; results.leads += r.leads; results.emails += r.emails; results.charges += r.charges
      } catch (err) {
        results.errors.push(`Workspace ${ws.name}: ${String(err)}`)
      }
    }
    console.log('[backfill] complete:', { ...results, errors: results.errors.length })
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
