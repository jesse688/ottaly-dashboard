import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const start = p.get('start') ?? new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
  const end = p.get('end') ?? new Date().toISOString().split('T')[0]

  try {
    const [totalsRes, rowsRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'sent') AS sent,
           COUNT(*) FILTER (WHERE event_type = 'open') AS opens,
           COUNT(*) FILTER (WHERE event_type = 'reply') AS replies,
           COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounces
         FROM email_events
         WHERE created_at >= $1 AND created_at < $2::date + 1`,
        [start, end]
      ),
      pool.query(
        `SELECT
           w.id AS workspace_id, w.name AS workspace_name,
           COUNT(*) FILTER (WHERE e.event_type = 'sent') AS sent,
           COUNT(*) FILTER (WHERE e.event_type = 'open') AS opens,
           COUNT(*) FILTER (WHERE e.event_type = 'reply') AS replies,
           COUNT(*) FILTER (WHERE e.event_type = 'bounce') AS bounces
         FROM email_events e
         JOIN workspaces w ON w.id = e.workspace_id
         WHERE e.created_at >= $1 AND e.created_at < $2::date + 1
         GROUP BY w.id, w.name
         ORDER BY sent DESC`,
        [start, end]
      ),
    ])

    const t = totalsRes.rows[0]
    const rows = rowsRes.rows.map(r => ({
      ...r,
      sent: parseInt(r.sent),
      opens: parseInt(r.opens),
      replies: parseInt(r.replies),
      bounces: parseInt(r.bounces),
      open_rate: r.sent > 0 ? r.opens / r.sent : 0,
      reply_rate: r.sent > 0 ? r.replies / r.sent : 0,
      bounce_rate: r.sent > 0 ? r.bounces / r.sent : 0,
    }))

    return NextResponse.json({
      totals: {
        sent: parseInt(t.sent),
        opens: parseInt(t.opens),
        replies: parseInt(t.replies),
        bounces: parseInt(t.bounces),
      },
      rows,
      period: `${start} to ${end}`,
    })
  } catch (err) {
    console.error('[stats]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
