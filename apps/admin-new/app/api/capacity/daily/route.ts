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
    // Rule: a mailbox counts toward capacity only if it's ALLOWED to send
    // (daily_limit > 0). A paused pool like Winnr Generic (daily_limit 0) is
    // therefore excluded from capacity automatically — and if it's ever given a
    // limit again, it counts again. No hard-coded supplier name.
    // On the SENT side we DON'T filter by limit: if a box actually sent (it won't
    // while paused at 0), that send is real and counts — "if it's sending,
    // include it". This keeps the page total in step with PV.
    const CAN_SEND = `daily_limit > 0`
    const [capRes, sentRes, capProvRes, sentProvRes, histRes, pausedRes, todayRes] = await Promise.all([
      pool.query(`
        SELECT workspace_id,
          MAX(workspace_name) AS workspace_name,
          COUNT(*)::int AS mailboxes,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_mailboxes,
          COALESCE(SUM(daily_limit) FILTER (WHERE status = 'ACTIVE'), 0)::int AS capacity,
          AVG(sending_gap) FILTER (WHERE status = 'ACTIVE' AND sending_gap > 0) AS avg_gap_min
        FROM mailbox_full
        WHERE ignored_at IS NULL AND workspace_id IS NOT NULL AND status = 'ACTIVE' AND ${CAN_SEND}
        GROUP BY workspace_id`),
      pool.query(`
        SELECT workspace_id, COALESCE(SUM(sent),0)::int AS sent
        FROM mailbox_daily_stats WHERE date = CURRENT_DATE GROUP BY workspace_id`),
      // PER PROVIDER capacity + configured interval — SMTP / Google / Microsoft
      // each send on their own limit + gap, so the fix must be per provider.
      pool.query(`
        SELECT workspace_id, type AS provider,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_boxes,
          COALESCE(SUM(daily_limit) FILTER (WHERE status = 'ACTIVE'), 0)::int AS capacity,
          AVG(sending_gap) FILTER (WHERE status = 'ACTIVE' AND sending_gap > 0) AS avg_gap_min
        FROM mailbox_full
        WHERE ignored_at IS NULL AND workspace_id IS NOT NULL AND status = 'ACTIVE' AND ${CAN_SEND}
        GROUP BY workspace_id, type`),
      // PER PROVIDER sent today (all real sends count).
      pool.query(`
        SELECT workspace_id, provider, COALESCE(SUM(sent),0)::int AS sent
        FROM mailbox_daily_stats WHERE date = CURRENT_DATE
        GROUP BY workspace_id, provider`),
      pool.query(`
        SELECT date, COALESCE(SUM(sent),0)::int AS sent
        FROM mailbox_daily_stats WHERE date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY date ORDER BY date`, [days]),
      // Dashboard-only per-client pause flag (excludes them from the totals).
      pool.query(`SELECT workspace_id FROM capacity_paused_clients`).catch(() => ({ rows: [] as { workspace_id: string }[] })),
      // Does today's row exist yet? Distinguishes "not synced / nothing sent yet"
      // from a real 0 — so the page doesn't scream "100% wasted" at 8am.
      pool.query(`SELECT COUNT(*)::int AS n FROM mailbox_daily_stats WHERE date = CURRENT_DATE`),
    ])

    const sentByWs = new Map<string, number>(sentRes.rows.map(r => [r.workspace_id, r.sent]))
    // Per-provider sent, keyed "ws|provider".
    const sentByWsProv = new Map<string, number>(
      sentProvRes.rows.map(r => [`${r.workspace_id}|${r.provider}`, r.sent])
    )
    // Per-provider capacity rows grouped by workspace.
    const provByWs = new Map<string, { provider: string; activeBoxes: number; capacity: number; avgGapMin: number | null }[]>()
    for (const r of capProvRes.rows) {
      const arr = provByWs.get(r.workspace_id) ?? []
      arr.push({ provider: r.provider, activeBoxes: r.active_boxes, capacity: r.capacity, avgGapMin: r.avg_gap_min != null ? Number(r.avg_gap_min) : null })
      provByWs.set(r.workspace_id, arr)
    }
    const pausedSet = new Set<string>(pausedRes.rows.map((r: { workspace_id: string }) => r.workspace_id))
    const hasTodayData = (todayRes.rows[0]?.n ?? 0) > 0
    const { fraction, ukTime } = ukDayFraction()

    // Hours left in the 08:00–17:00 window (min 0). Used for pace/interval math.
    const WINDOW_H = 9
    const hoursLeft = Math.max(0, WINDOW_H * (1 - fraction))

    const clients = capRes.rows
      .map(r => {
        const capacity = r.capacity as number
        const activeBoxes = r.active_mailboxes as number
        const avgGapMin = r.avg_gap_min != null ? Number(r.avg_gap_min) : null
        const sentToday = sentByWs.get(r.workspace_id) ?? 0

        // ── 1. LIVE utilisation (now) — independent of projection ──
        // pace% = sent ÷ expected-by-now (100 = exactly on pace, >100 ahead).
        // done% = sent ÷ full capacity (how much of today's total is done).
        const expectedByNow = capacity * fraction
        const pacePct = expectedByNow > 0 ? Math.round((sentToday / expectedByNow) * 100)
          : (sentToday > 0 ? 999 : 0)
        const donePct = capacity > 0 ? Math.round((sentToday / capacity) * 100) : 0
        // ahead / on / behind (10% band around 100 = "on").
        const paceState: 'ahead' | 'on' | 'behind' =
          fraction < 0.05 ? 'on' // too early to judge — treat as on-pace
          : pacePct >= 110 ? 'ahead' : pacePct >= 90 ? 'on' : 'behind'

        // ── 2. Projection — will they hit capacity at the current rate? ──
        const raw = fraction > 0 ? sentToday / fraction : sentToday
        const projected = capacity > 0 ? Math.min(Math.round(raw), capacity) : Math.round(raw)
        const onTarget = capacity > 0 && projected >= capacity * 0.95

        // ── 2b. Projection (unused fields kept minimal) ──
        void avgGapMin
        const wasted = Math.max(0, capacity - projected)

        // ── 3. Speed-to-fix, PER PROVIDER ──
        // Each provider type (smtp/google/microsoft) sends on its OWN daily
        // limit + interval, so the fix must be given per provider — a blended
        // client-wide interval is not actionable. Per-mailbox interval =
        // (minutes available × active boxes) ÷ sends; target and needed share
        // the formula so "behind => needed < target" always holds.
        // The interval is only the BOTTLENECK if, at the ACTUAL configured gap,
        // the boxes physically can't push the remaining volume in the time left.
        // Their daily_limit is usually far tighter than the interval (e.g. 10/day
        // at a 20m gap has huge headroom), so "behind" is normally sends-not-
        // happening (paused campaign / no leads / warmup), NOT a slow interval.
        // We surface the REAL interval, and only suggest tightening when it's the
        // genuine constraint — otherwise flag the provider as "stalled".
        const minutesLeft = hoursLeft * 60
        const PLABEL: Record<string, string> = { smtp: 'SMTP', google: 'Google', microsoft: 'Microsoft' }
        const provRows = provByWs.get(r.workspace_id) ?? []
        const providers = provRows
          .filter(p => p.capacity > 0)
          .map(p => {
            const pSent = sentByWsProv.get(`${r.workspace_id}|${p.provider}`) ?? 0
            const pRemaining = Math.max(0, p.capacity - pSent)
            // Actual configured interval (PV sending_gap). Null if unknown.
            const currentIntervalMin = p.avgGapMin != null ? Math.round(p.avgGapMin) : null
            // On track by end of day at the current pace?
            const onTgt = p.capacity > 0 && (fraction > 0 ? Math.min(pSent / fraction, p.capacity) : pSent) >= p.capacity * 0.95
            // Max sends the boxes CAN do in the time left at the current interval.
            const maxSendsAtCurrent = (currentIntervalMin && currentIntervalMin > 0)
              ? Math.floor(p.activeBoxes * (minutesLeft / currentIntervalMin)) : Infinity
            // Interval IS the bottleneck only when even flat-out it can't finish.
            const intervalIsBottleneck = pRemaining > 0 && maxSendsAtCurrent < pRemaining
            // If it is, the interval needed to just fit the remaining in the time.
            const neededIntervalMin = intervalIsBottleneck && pRemaining > 0
              ? Math.max(1, Math.floor((minutesLeft * p.activeBoxes) / pRemaining)) : null
            // Behind but interval has headroom => sending is stalled, not paced.
            const stalled = !onTgt && !intervalIsBottleneck && pRemaining > 0 && fraction > 0.15 && pSent < p.capacity * fraction * 0.5
            return {
              provider: PLABEL[p.provider] ?? p.provider,
              activeBoxes: p.activeBoxes, capacity: p.capacity, sent: pSent,
              currentIntervalMin, neededIntervalMin,
              needsSpeedUp: intervalIsBottleneck && neededIntervalMin != null,
              stalled,
            }
          })
          .sort((a, b) => b.capacity - a.capacity)

        return {
          workspace_id: r.workspace_id,
          client: r.workspace_name || r.workspace_id,
          capacity, mailboxes: r.mailboxes, activeMailboxes: activeBoxes,
          sentToday,
          pacePct, donePct, paceState,
          projected, onTarget, wasted,
          providers,
          needsSpeedUp: providers.some(p => p.needsSpeedUp),
          stalled: providers.some(p => p.stalled),
          paused: pausedSet.has(r.workspace_id),
        }
      })
      .filter(c => c.capacity > 0 || c.sentToday > 0)
      // Behind-and-fixable first, then most wasted — the CMs' action list.
      .sort((a, b) => (Number(b.needsSpeedUp) - Number(a.needsSpeedUp)) || (b.wasted - a.wasted))

    // Totals count only NON-paused clients — a paused client's idle capacity is
    // intentional, so it shouldn't inflate "wasted" or drag utilisation down.
    const active = clients.filter(c => !c.paused)
    const totalCapacity = active.reduce((s, c) => s + c.capacity, 0)
    const totalSentToday = active.reduce((s, c) => s + c.sentToday, 0)
    const totalProjected = active.reduce((s, c) => s + c.projected, 0)

    const history = histRes.rows.map(r => {
      const date = new Date(r.date).toISOString().slice(0, 10)
      const sent = r.sent as number
      return { date, sent, wasted: Math.max(0, totalCapacity - sent) }
    })

    return NextResponse.json({
      ukTime,
      dayFraction: Math.round(fraction * 100),
      hasTodayData,
      pausedCount: pausedSet.size,
      summary: {
        totalCapacity, totalSentToday, totalProjected,
        totalWasted: Math.max(0, totalCapacity - totalProjected),
        // Projected utilisation (end-of-day forecast).
        usedPct: totalCapacity > 0 ? Math.round((totalProjected / totalCapacity) * 100) : 0,
        // LIVE pace right now: sent vs where they should be by this hour.
        livePacePct: totalCapacity > 0 && fraction > 0
          ? Math.round((totalSentToday / (totalCapacity * fraction)) * 100) : 0,
        // % of the full day's capacity actually sent so far.
        donePct: totalCapacity > 0 ? Math.round((totalSentToday / totalCapacity) * 100) : 0,
      },
      clients,
      history,
    })
  } catch (err) {
    console.error('[capacity/daily]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
