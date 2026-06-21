import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'
import { getCacheFreshness } from '@/lib/freshness'

export const dynamic = 'force-dynamic'

interface Row {
  email: string | null
  workspace_id: string
  workspace_name: string | null
  warmup_score: number | null
  warmup_sent: number | null
  warmup_landed: number | null
  health: string | null
  snapshot_date: string
}

// Reads the warmup_daily_stats cache table (latest snapshot per mailbox).
// Empty until the reconciler fills it — the page then shows "Not yet synced".
export async function GET() {
  try {
    const rows = await q<Row>(
      `SELECT DISTINCT ON (w.email_acc_id)
              w.email, w.workspace_id, ws.workspace_name,
              w.warmup_score, w.warmup_sent, w.warmup_landed, w.health,
              w.snapshot_date
       FROM warmup_daily_stats w
       LEFT JOIN workspace_stats ws ON ws.workspace_id = w.workspace_id
       ORDER BY w.email_acc_id, w.snapshot_date DESC`,
      [], { tag: 'warmup' },
    )
    const fresh = await getCacheFreshness('warmup_daily_stats')

    const buckets = { healthy: 0, low_score: 0, bouncing: 0, disabled: 0, unknown: 0 }
    for (const r of rows) {
      const h = (r.health ?? 'unknown') as keyof typeof buckets
      if (h in buckets) buckets[h]++; else buckets.unknown++
    }

    return NextResponse.json({
      mailboxes: rows.map(r => ({
        email: r.email,
        workspace_id: r.workspace_id,
        workspace_name: r.workspace_name || r.workspace_id,
        score: r.warmup_score,
        sent: r.warmup_sent ?? 0,
        landed: r.warmup_landed ?? 0,
        health: r.health ?? 'unknown',
      })),
      buckets,
      syncedAt: fresh.syncedAt,
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'warmup' } })
    const msg = err instanceof Error ? err.message : 'Failed to load warmup'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
