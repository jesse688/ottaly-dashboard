import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// GET /api/stats/reconcile?date=YYYY-MM-DD
// Per-workspace reconciliation for ONE date, all clients at once:
//   - name + workspace_id
//   - perf cache: sent, replies, ooo, pos (PlusVibe email-stats header)
//   - human = replies - ooo ; humanRR, replyRateWithOoo
//   - leads_esp_window: esp_leads INTERESTED dated in the window
//   - leads_esp_today: esp_leads INTERESTED whose lead-date is exactly `date`
//   - leads_revenue_window: old PV-sourced revenue_leads count (for comparison)
// Lets us see at a glance where the dashboard disagrees with reality without
// hunting one workspace at a time.
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10)

  try {
    const [wsRes, perfRes, espRes, revRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT workspace_id, workspace_name FROM workspace_stats
          WHERE workspace_id IS NOT NULL AND workspace_id <> ''`,
      ),
      pool.query(
        `SELECT ws_id, data FROM perf_cache_daily WHERE date = $1`,
        [date],
      ),
      pool.query(
        `SELECT workspace_id,
                COUNT(*) FILTER (
                  WHERE COALESCE(first_replied_at, created_at, synced_at)::date >= $1::date
                    AND COALESCE(first_replied_at, created_at, synced_at)::date <= $1::date
                )::int AS today,
                COUNT(*)::int AS all_time
           FROM esp_leads
          WHERE label = 'INTERESTED'
          GROUP BY workspace_id`,
        [date],
      ),
      pool.query(
        `SELECT workspace_id, COUNT(*)::int AS n FROM revenue_leads
          WHERE pv_nonlead IS NOT TRUE AND date = $1
          GROUP BY workspace_id`,
        [date],
      ),
    ])

    const perf: Record<string, Record<string, number>> = {}
    for (const r of perfRes.rows) perf[r.ws_id] = r.data || {}
    const esp: Record<string, { today: number; all_time: number }> = {}
    for (const r of espRes.rows) esp[r.workspace_id] = { today: r.today, all_time: r.all_time }
    const rev: Record<string, number> = {}
    for (const r of revRes.rows) rev[r.workspace_id] = r.n

    // Optional: pull LIVE PlusVibe email-stats for the same date, so cached can
    // be compared to what PV reports right now. Off by default (one PV call per
    // workspace); enable with ?live=1.
    const wantLive = req.nextUrl.searchParams.get('live') === '1'
    const pvKey = process.env.PLUSVIBE_KEY || process.env.PLUSVIBE_API_KEY || ''
    const live: Record<string, Record<string, number> | string> = {}
    if (wantLive && pvKey) {
      await Promise.all(
        wsRes.rows.map(async (w: { workspace_id: string }) => {
          try {
            const r = await fetch(
              `https://api.plusvibe.ai/api/v1/account/email-stats?workspace_id=${w.workspace_id}&start_date=${date}&end_date=${date}`,
              { headers: { 'x-api-key': pvKey } },
            )
            const raw = await r.json().catch(() => ({}))
            const h = raw?.header || {}
            live[w.workspace_id] = {
              sent: h.total_sent_count ?? 0,
              replies: h.total_reply_count ?? 0,
              ooo: h.total_ooo_reply_count ?? 0,
              pos: h.total_pos_reply_count ?? 0,
            }
          } catch (e) {
            live[w.workspace_id] = e instanceof Error ? e.message : 'pv error'
          }
        }),
      )
    }

    const rows = wsRes.rows
      .map((w: { workspace_id: string; workspace_name: string }) => {
        const d = perf[w.workspace_id] || {}
        const sent = Number(d.sent) || 0
        const replies = Number(d.replies) || 0
        const ooo = Number(d.oooReplies) || 0
        const pos = Number(d.posReplies) || 0
        const human = Math.max(0, replies - ooo)
        const pct = (n: number) => (sent > 0 ? +((n / sent) * 100).toFixed(2) : 0)
        return {
          name: w.workspace_name || w.workspace_id,
          workspace_id: w.workspace_id,
          sent,
          replies,
          ooo,
          pos,
          human,
          humanRR: pct(human),
          replyRateWithOoo: pct(replies),
          leads_esp_today: esp[w.workspace_id]?.today ?? 0,
          leads_esp_all_time: esp[w.workspace_id]?.all_time ?? 0,
          leads_revenue_today: rev[w.workspace_id] ?? 0,
          live_pv: live[w.workspace_id],
        }
      })
      .filter((r) => r.sent > 0 || r.replies > 0 || r.leads_esp_today > 0 || r.leads_revenue_today > 0)
      .sort((a, b) => b.replies - a.replies)

    return NextResponse.json({
      date,
      pvKeyConfigured: !!(process.env.PLUSVIBE_KEY || process.env.PLUSVIBE_API_KEY),
      count: rows.length,
      rows,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
