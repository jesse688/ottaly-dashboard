import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { judgeable } from '@/lib/mailbox-health-queries'
import { MIN_JUDGE } from '@/lib/mailbox-health'

export const dynamic = 'force-dynamic'

/**
 * Per-mailbox detail.
 *
 * Only mailboxes with enough contacted to judge appear. min_contacted can be
 * lowered deliberately, but the default exists for a reason: at 25 sends and a
 * 6% OOO rate, chance alone puts P(zero OOO) at ~21%.
 */
export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client') || undefined
  const minContacted = Math.max(0, Number(req.nextUrl.searchParams.get('min_contacted')) || MIN_JUDGE)
  try {
    const rows = await judgeable({ client, minContacted })
    return NextResponse.json({
      min_contacted: minContacted,
      count: rows.length,
      mailboxes: rows,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:mailboxes' }, extra: { client } })
    const msg = err instanceof Error ? err.message : 'Failed to load mailboxes'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
