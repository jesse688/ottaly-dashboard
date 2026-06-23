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

    // REPLIES come from OUR unibox, not PlusVibe — PV doesn't count replies it
    // tagged "other". A reply is ANY inbound response EXCEPT warm-up (OOO and
    // automatic replies DO count as replies). Distinct leads per workspace. Sent
    // volume stays PlusVibe-sourced.
    const uniRes = await pool.query(
      `SELECT workspace_id,
              COUNT(DISTINCT lower(lead_email)) FILTER (WHERE received_at >= CURRENT_DATE - INTERVAL '30 days') AS r30,
              COUNT(DISTINCT lower(lead_email)) FILTER (WHERE received_at >= CURRENT_DATE - INTERVAL '90 days') AS r90
         FROM unibox_replies
        WHERE folder <> 'warmup'
          AND COALESCE(admin_label, category, '') <> 'warmup'
        GROUP BY workspace_id`
    )
    const uni = new Map<string, { r30: number; r90: number }>()
    for (const u of uniRes.rows) uni.set(String(u.workspace_id), { r30: Number(u.r30) || 0, r90: Number(u.r90) || 0 })

    // Override reply counts with the GREATER of PV vs unibox so we never under-report,
    // and recompute reply rate against PV's sent volume.
    const rows = res.rows.map(r => {
      const u = uni.get(String(r.workspace_id))
      const replied_30d = Math.max(r.replied_30d ?? 0, u?.r30 ?? 0)
      const replied_90d = Math.max(r.replied_90d ?? 0, u?.r90 ?? 0)
      return {
        ...r,
        replied_30d,
        replied_90d,
        reply_rate_30d: (r.sent_30d ?? 0) > 0 ? replied_30d / r.sent_30d : 0,
        reply_rate_90d: (r.sent_90d ?? 0) > 0 ? replied_90d / r.sent_90d : 0,
      }
    })
    const totals = rows.reduce((acc, r) => ({
      sent: acc.sent + (r.sent_30d ?? 0),
      replies: acc.replies + (r.replied_30d ?? 0),
      leads: acc.leads + (r.leads_30d ?? 0),
    }), { sent: 0, replies: 0, leads: 0 })
    const replyRate = totals.sent > 0 ? totals.replies / totals.sent : 0

    return NextResponse.json({ rows, totals: { ...totals, replyRate }, period: '30d' })
  } catch (err) {
    console.error('[stats]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
