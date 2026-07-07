import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// ── Daily Capacity / Utilisation ────────────────────────────────────────────
// "Are the CMs using all our sending resource?" Per client, for TODAY:
//   capacity  = Σ daily_limit of ACTIVE mailboxes (paused / limit-0 count as 0)
//   sentToday = today's sent from mailbox_daily_stats (updated intraday)
//   projected = pace estimate: sentToday ÷ (fraction of the 08:00–17:00 UK
//               sending day elapsed), capped at capacity
//   used%     = projected / capacity ; wasted = capacity − projected
// Plus a daily history (sent vs wasted per day) for the trend chart.
//
// NOTE: capacity is a LIVE snapshot (today's active limits). mailbox_daily_stats
// stores per-day SENT but not per-day capacity, so historical "wasted" uses
// today's capacity as the baseline — an approximation flagged in the UI.

export const dynamic = 'force-dynamic'

// Fraction [0..1] of the 08:00–17:00 UK sending window elapsed now. Server clock
// is UTC; Intl gives the UK wall-clock hour so DST is handled without a tz lib.
function ukDayFraction(): { fraction: number; ukTime: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  const startMin = 8 * 60, endMin = 17 * 60
  const nowMin = h * 60 + m
  const fraction = Math.max(0, Math.min(1, (nowMin - startMin) / (endMin - startMin)))
  return { fraction, ukTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
}

export async function GET() {
  try {
    const days = 14
    const [capRes, sentRes, histRes] = await Promise.all([
      pool.query(`
        SELECT workspace_id,
          MAX(workspace_name) AS workspace_name,
          COUNT(*)::int AS mailboxes,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_mailboxes,
          COALESCE(SUM(daily_limit) FILTER (WHERE status = 'ACTIVE'), 0)::int AS capacity
        FROM mailbox_full
        WHERE ignored_at IS NULL AND workspace_id IS NOT NULL
        GROUP BY workspace_id`),
      pool.query(`
        SELECT workspace_id, COALESCE(SUM(sent),0)::int AS sent
        FROM mailbox_daily_stats WHERE date = CURRENT_DATE GROUP BY workspace_id`),
      pool.query(`
        SELECT date, COALESCE(SUM(sent),0)::int AS sent
        FROM mailbox_daily_stats WHERE date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY date ORDER BY date`, [days]),
    ])

    const sentByWs = new Map<string, number>(sentRes.rows.map(r => [r.workspace_id, r.sent]))
    const { fraction, ukTime } = ukDayFraction()

    const clients = capRes.rows
      .map(r => {
        const capacity = r.capacity as number
        const sentToday = sentByWs.get(r.workspace_id) ?? 0
        const raw = fraction > 0 ? sentToday / fraction : sentToday
        const projected = capacity > 0 ? Math.min(Math.round(raw), capacity) : Math.round(raw)
        const usedPct = capacity > 0 ? Math.round((projected / capacity) * 100) : 0
        const wasted = Math.max(0, capacity - projected)
        return {
          workspace_id: r.workspace_id,
          client: r.workspace_name || r.workspace_id,
          capacity, mailboxes: r.mailboxes, activeMailboxes: r.active_mailboxes,
          sentToday, projected, usedPct, wasted,
        }
      })
      .filter(c => c.capacity > 0 || c.sentToday > 0)
      .sort((a, b) => b.wasted - a.wasted) // biggest wasted capacity first — the CMs' problem

    const totalCapacity = clients.reduce((s, c) => s + c.capacity, 0)
    const totalSentToday = clients.reduce((s, c) => s + c.sentToday, 0)
    const totalProjected = clients.reduce((s, c) => s + c.projected, 0)

    const history = histRes.rows.map(r => {
      const date = new Date(r.date).toISOString().slice(0, 10)
      const sent = r.sent as number
      return { date, sent, wasted: Math.max(0, totalCapacity - sent) }
    })

    return NextResponse.json({
      ukTime,
      dayFraction: Math.round(fraction * 100),
      summary: {
        totalCapacity, totalSentToday, totalProjected,
        totalWasted: Math.max(0, totalCapacity - totalProjected),
        usedPct: totalCapacity > 0 ? Math.round((totalProjected / totalCapacity) * 100) : 0,
      },
      clients,
      history,
    })
  } catch (err) {
    console.error('[capacity/daily]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
