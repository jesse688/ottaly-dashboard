import { NextResponse, type NextRequest } from 'next/server'
import { ready } from '@/lib/db'
import { backfillReplied } from '@/lib/backfill'

// Scheduled sweep: keep "Needs reply" accurate. Leads replied to inside Bison
// (not via the portal) never produce a portal OUT message, so without this they
// sit in "Needs reply" forever. This re-checks each not-yet-responded lead's
// live Bison thread and stamps first_responded_at when a reply was sent.
//
// Bison calls are slow (one thread per lead), so each run processes a bounded
// batch (default 40, override with ?limit=). `remaining` in the response shows
// how many are still unchecked — schedule it every few minutes and it catches
// up, then idles cheaply (no candidates → no Bison calls).
//
// GET /api/cron/backfill-replied?secret=CRON_SECRET[&limit=40][&workspace=<pvId>]
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expected = process.env.CRON_SECRET
  if (!secret || !expected || secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40))
  const workspaceId = url.searchParams.get('workspace') ?? undefined

  try {
    const result = await backfillReplied({ workspaceId, limit })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[cron/backfill-replied] error:', err)
    return NextResponse.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 })
  }
}
