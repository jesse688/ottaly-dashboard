import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { runIngestNow } from '@/lib/mailbox-health'
import { lastRun } from '@/lib/mailbox-health-queries'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Run the ingest on demand.
 *
 * WHY THIS EXISTS. The scheduler used to be the only caller of ingest(), and
 * it stood down whenever mailbox-sync held the shared PlusVibe bulk claim —
 * which is nearly always, since that claim is re-armed every 30 minutes for 30
 * minutes. When ingest stopped on 2026-09-19 there was no way to restart it
 * short of a redeploy. Now there is.
 *
 * Auth is the app session, via middleware, like every other mailbox-health
 * route. No key in a URL: this one is only ever called from the dashboard.
 *
 * GET  reports whether today's run has landed (cheap, for the staleness badge).
 * POST runs it. ?mode=backfill walks each workspace back to its oldest mailbox;
 * default nightly refreshes the current window, and any workspace with no
 * banked history is backfilled automatically regardless of mode.
 */
export async function GET() {
  try {
    return NextResponse.json({ last_run: await lastRun(), updatedAt: new Date().toISOString() })
  } catch (err) {
    Sentry.captureException(err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') === 'backfill' ? 'backfill' : 'nightly'
  try {
    // force: the operator asked for it, so skip the bulk-active and ran-today
    // guards that exist to keep the unattended schedule polite.
    const ok = await runIngestNow(mode, true)
    return NextResponse.json({
      ok,
      mode,
      last_run: await lastRun(),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
