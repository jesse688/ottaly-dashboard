import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { backfillReplied } from '@/lib/backfill'

// One-shot (re-runnable) cleanup: for portal leads, mark those already replied to
// in Bison as "responded" so they drop off "Needs reply". Logic lives in
// lib/backfill.ts (shared with the scheduled cron at /api/cron/backfill-replied).
//
// POST ?workspace=<pvId>  → just that client (faster)
// POST                    → all clients
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const onlyWs = new URL(req.url).searchParams.get('workspace') ?? undefined
  const result = await backfillReplied({ workspaceId: onlyWs })
  return NextResponse.json(result)
}
