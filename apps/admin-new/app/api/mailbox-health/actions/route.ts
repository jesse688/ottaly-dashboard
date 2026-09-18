import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { buildActions, buyCalendar } from '@/lib/mailbox-actions'

export const dynamic = 'force-dynamic'

/**
 * The action queue: what to do, ranked, with the evidence behind each item.
 *
 * Also returns the buy calendar, since both answer "what should I do" and the
 * page shows them together.
 */
export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client') || undefined
  try {
    const [actions, buy] = await Promise.all([buildActions(client), buyCalendar(client)])
    return NextResponse.json({
      actions,
      counts: {
        critical: actions.filter(a => a.severity === 'critical').length,
        high: actions.filter(a => a.severity === 'high').length,
        medium: actions.filter(a => a.severity === 'medium').length,
        low: actions.filter(a => a.severity === 'low').length,
      },
      buy,
      buy_total: Number(buy.reduce((s, b) => s + b.est_cost, 0).toFixed(2)),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:actions' }, extra: { client } })
    const msg = err instanceof Error ? err.message : 'Failed to build the action queue'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
