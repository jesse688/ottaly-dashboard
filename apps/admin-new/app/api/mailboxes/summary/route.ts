import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { legacyFetch } from '@/lib/api'
import { getCacheFreshness } from '@/lib/freshness'

interface SupplierStats {
  name: string
  total: number
  active: number
  broken: number
  replyRate: number
  bounceRate: number
  warmupPct: number
  authClean: number
  sentPerDay: number
}

interface LegacySupplier {
  name?: string
  total?: number
  active?: number
  broken?: number
  replyRate?: number | string
  bounceRate?: number | string
  warmupPct?: number | string
  authClean?: number | string
  sentPerDay?: number | string
}

// Per-supplier performance summary. Sourced from the legacy aggregate, which is
// fed by the reconciler (mailbox_daily_stats). Empty until the reconciler runs →
// the page shows a "Not yet synced" freshness badge, never an error.
export async function GET() {
  const fresh = await getCacheFreshness('mailbox_daily_stats')
  try {
    const data = (await legacyFetch('/api/admin/mailboxes/summary')) as {
      suppliers?: LegacySupplier[]
    }
    const suppliers: SupplierStats[] = (data.suppliers || []).map(s => ({
      name: s.name || 'unassigned',
      total: s.total || 0,
      active: s.active || 0,
      broken: s.broken || 0,
      replyRate: Number(s.replyRate) || 0,
      bounceRate: Number(s.bounceRate) || 0,
      warmupPct: Number(s.warmupPct) || 0,
      authClean: Number(s.authClean) || 0,
      sentPerDay: Number(s.sentPerDay) || 0,
    }))
    return NextResponse.json({ suppliers, syncedAt: fresh.syncedAt })
  } catch (err) {
    // Not-yet-synced is expected: degrade to empty + null freshness, not a 500.
    Sentry.captureException(err, { tags: { tag: 'mailboxes-summary' } })
    return NextResponse.json({ suppliers: [], syncedAt: null })
  }
}
