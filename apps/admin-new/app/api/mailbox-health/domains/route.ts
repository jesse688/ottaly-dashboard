import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { domainLoad } from '@/lib/mailbox-health-queries'

export const dynamic = 'force-dynamic'

/**
 * Sends per domain.
 *
 * The estate's strongest measured lever: sends-per-domain correlates with OOO
 * at r = -0.47, against mailboxes-per-domain at r = -0.10. Judge a domain on
 * volume, never headcount.
 */
export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client') || undefined
  try {
    const domains = await domainLoad(client)
    return NextResponse.json({
      count: domains.length,
      // Bulk-provisioned domains run many mailboxes at a low rate by design,
      // so the flag is volume per mailbox, not how many sit on the domain.
      heavy: domains.filter(d => d.sent_per_mbx > 800).length,
      bulk: domains.filter(d => d.mailboxes >= 20).length,
      domains,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:domains' }, extra: { client } })
    const msg = err instanceof Error ? err.message : 'Failed to load domains'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
