import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         workspace_id,
         workspace_name,
         (stats->>'sent_30d')::int AS sent_30d,
         (stats->>'sent_90d')::int AS sent_90d,
         (stats->>'replied_30d')::int AS replied_30d,
         (stats->>'replied_90d')::int AS replied_90d,
         (stats->>'leads_30d')::int AS leads_30d,
         (stats->>'leads_90d')::int AS leads_90d,
         (stats->>'reply_rate_30d')::numeric AS reply_rate_30d,
         (stats->>'reply_rate_90d')::numeric AS reply_rate_90d,
         (stats->>'mailbox_count')::int AS mailbox_count,
         (stats->>'contacts_total')::int AS contacts_total,
         stats->>'client_status' AS client_status,
         computed_at
       FROM workspace_stats
       ORDER BY (stats->>'sent_30d')::int DESC NULLS LAST`
    )

    const rows = res.rows
    const totals = rows.reduce((acc, r) => ({
      sent: acc.sent + (r.sent_30d ?? 0),
      replies: acc.replies + (r.replied_30d ?? 0),
      leads: acc.leads + (r.leads_30d ?? 0),
      // Weighted average reply rate using PlusVibe's own stored rate × sent volume
      weightedRateSum: acc.weightedRateSum + ((r.reply_rate_30d ?? 0) * (r.sent_30d ?? 0)),
    }), { sent: 0, replies: 0, leads: 0, weightedRateSum: 0 })
    const replyRate = totals.sent > 0 ? totals.weightedRateSum / totals.sent : 0

    return NextResponse.json({ rows, totals: { ...totals, replyRate }, period: '30d' })
  } catch (err) {
    console.error('[stats]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
