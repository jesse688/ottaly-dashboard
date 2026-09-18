import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import {
  clientSummary, rankByUrgency, judgeable, providerStats,
  domainLoad, settingsAudit, estateTrend, lastRun,
} from '@/lib/mailbox-health-queries'
import { BURN_THRESHOLD, MIN_JUDGE } from '@/lib/mailbox-health'

export const dynamic = 'force-dynamic'

/**
 * Everything the mailbox health page needs at the top level, in one call.
 *
 * With ?client=, every figure is scoped to that client instead of the estate —
 * the same data, one client's worth, rather than a different view.
 */
export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client') || undefined
  try {
    const [clients, providers, domains, settings, trend, ingest] = await Promise.all([
      clientSummary(client),
      providerStats(),
      domainLoad(client),
      settingsAudit(client),
      estateTrend(12, client),
      lastRun(),
    ])

    const ranked = rankByUrgency(clients)

    // Judged separately: only mailboxes with enough contacted to mean
    // anything. Below the floor a mailbox is "insufficient data", never 0%.
    const mailboxes = await judgeable({ client })
    const underperforming = mailboxes.filter(m => (m.ooo_pct ?? 0) < 1.5).length

    return NextResponse.json({
      focus: client ?? null,
      all_clients: clients.map(c => c.client).sort(),
      thresholds: { burn: BURN_THRESHOLD, min_judge: MIN_JUDGE, dead_ooo_pct: 1.5 },
      // Spread FIRST, then the derived names — the other way round the spread
      // silently overwrites them, which is what `domains` was doing.
      estate: {
        ...settings,
        mailboxes: settings.total,
        clients: clients.length,
      },
      clients: ranked,
      providers,
      // Bulk-provisioned domains deliberately run many mailboxes at a low rate
      // each, so volume per mailbox is what flags a domain, never headcount.
      heavy_domains: domains.filter(d => d.sent_per_mbx > 800).length,
      underperforming,
      trend,
      last_ingest: ingest,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health' }, extra: { client } })
    const msg = err instanceof Error ? err.message : 'Failed to load mailbox health'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
