import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { backfillReplied, forceMarkPlusvibeResponded } from '@/lib/backfill'

// Cleanup for "Needs reply". Logic in lib/backfill.ts (shared with the cron).
//
// POST                       → check each lead's Bison thread, mark genuinely-replied ones
// POST ?workspace=<pvId>     → just that client
// POST ?mode=plusvibe        → ONE-OFF: mark ALL stuck HISTORIC PlusVibe leads
//                              responded directly (they live only in PlusVibe, so
//                              the Bison check can never clear them). Scoped to
//                              source='plusvibe' — never touches live Bison leads.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const onlyWs = url.searchParams.get('workspace') ?? undefined

  if (url.searchParams.get('mode') === 'plusvibe') {
    const { marked } = await forceMarkPlusvibeResponded(onlyWs)
    return NextResponse.json({ ok: true, mode: 'plusvibe', marked })
  }

  const result = await backfillReplied({ workspaceId: onlyWs })
  return NextResponse.json(result)
}
