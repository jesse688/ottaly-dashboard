import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'
import { getCacheFreshness } from '@/lib/freshness'

export const dynamic = 'force-dynamic'

interface Row {
  workspace_id: string
  workspace_name: string | null
  sent: number
  replies: number
  bounces: number
  leads: number
  reply_rate: number | null
  bounce_rate: number | null
  leads_left_pct: number | null
  active_campaigns: number
  paused_campaigns: number
  warmup_pct: number | null
  last_send_date: string | null
  status: string | null
  flagged: boolean
}

// Reads client_actions_cache (filled by the reconciler). Empty until then →
// page shows "Not yet synced". Replaces the legacy 6-call live PlusVibe fan-out.
export async function GET() {
  try {
    const rows = await q<Row>(
      `SELECT workspace_id, workspace_name, sent, replies, bounces, leads,
              reply_rate, bounce_rate, leads_left_pct, active_campaigns,
              paused_campaigns, warmup_pct, last_send_date, status, flagged
       FROM client_actions_cache
       ORDER BY flagged DESC, sent DESC`,
      [], { tag: 'client-actions' },
    )
    const fresh = await getCacheFreshness('client_actions_cache')
    return NextResponse.json({
      rows: rows.map(r => ({
        workspace_id: r.workspace_id,
        name: r.workspace_name || r.workspace_id,
        sent: r.sent, replies: r.replies, bounces: r.bounces, leads: r.leads,
        replyRate: r.reply_rate ?? (r.sent > 0 ? r.replies / r.sent : 0),
        bounceRate: r.bounce_rate ?? (r.sent > 0 ? r.bounces / r.sent : 0),
        leadsLeftPct: r.leads_left_pct,
        activeCampaigns: r.active_campaigns,
        pausedCampaigns: r.paused_campaigns,
        warmupPct: r.warmup_pct,
        lastSendDate: r.last_send_date,
        status: r.status ?? 'ok',
        flagged: r.flagged,
      })),
      syncedAt: fresh.syncedAt,
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'client-actions' } })
    const msg = err instanceof Error ? err.message : 'Failed to load actions'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
