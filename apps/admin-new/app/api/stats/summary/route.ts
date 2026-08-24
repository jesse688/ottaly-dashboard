import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { getActiveWorkspaceIds } from '@/lib/active-clients'
import { fetchPvDay, upsertPerfDay } from '@/lib/cache-warming' // live-fill missing/stale cache cells

interface DayData {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  contacted: number
  leads: number
}

interface Workspace {
  workspace_id: string
  name: string
  totals: {
    sent: number
    replies: number
    posReplies: number
    oooReplies: number
    bounces: number
    contacted: number
    leads: number
    replyRate: number
    allReplyRate: number
    bounceRate: number
    rtl: number
    lpt: number
    sendsPerDay: number
    repliesPerDay: number
  }
  series: DayData[]
}

// FRESH-START CUTOVER: PlusVibe-clean data begins here. The Bison→PV transition
// (2026-06-13..18) had near-zero/mixed sends and Bison-era rows skewed the numbers,
// so stats only count data on/after this date. Change this one constant to adjust.
//
// 2026-06-23: lowered 19→17 so "Last 7 Days" is a TRUE 7-day window that aligns
// with PV's own Last-7-Days view (which we reconcile against). With ~all sends
// now PV-native, 17–18 Jun no longer carry meaningful Bison noise. Override per
// env if a future window needs a different floor.
const STATS_CUTOVER = process.env.STATS_CUTOVER_DATE ?? '2026-06-17'

// How long a cached 'today' cell is trusted before we refetch it from PV.
// Today climbs all day, so it must expire — but not on every single request,
// which is what starved the live-fill budget and zeroed the page.
const TODAY_TTL_MS = Number(process.env.STATS_TODAY_TTL_MS ?? 120000)

// Enumerate inclusive YYYY-MM-DD strings from start..end, purely lexically (no
// Date/timezone math) so it never re-introduces a UTC/London divergence.
function enumerateDates(start: string, end: string, cap: number): string[] {
  const out: string[] = []
  // Use UTC noon to step days safely without DST/tz drift, but only to ADVANCE;
  // the emitted strings come from slicing, anchored on the input strings.
  let cur = new Date(`${start}T12:00:00Z`)
  const last = new Date(`${end}T12:00:00Z`)
  while (cur <= last && out.length < cap) {
    out.push(cur.toISOString().slice(0, 10))
    cur = new Date(cur.getTime() + 86400000)
  }
  return out
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const rawStart = searchParams.get('start')
  const end = searchParams.get('end')
  const workspaceIds = searchParams.get('workspace_ids')

  if (!rawStart || !end) {
    return NextResponse.json({ error: 'start and end required (YYYY-MM-DD)' }, { status: 400 })
  }
  // Clamp the start to the cutover — never count pre-cutover (Bison-era) data.
  const start = rawStart < STATS_CUTOVER ? STATS_CUTOVER : rawStart

  try {
    // Get active workspace list from workspace_stats
    const wsQuery = `
      SELECT DISTINCT workspace_id, workspace_name
      FROM workspace_stats
      WHERE workspace_id IS NOT NULL AND workspace_id != ''
      ORDER BY workspace_id
    `
    const wsRes = await pool.query(wsQuery)
    let workspaceList = wsRes.rows as Array<{ workspace_id: string; workspace_name: string }>

    // Apply workspace_ids filter if provided
    if (workspaceIds) {
      const ids = String(workspaceIds).split(',').filter(Boolean)
      workspaceList = workspaceList.filter(w => ids.includes(w.workspace_id))
    }

    // Hide inactive clients (legacy is the source of truth). Fails open: if the
    // status list is unavailable, show all rather than blank the page.
    const activeIds = await getActiveWorkspaceIds()
    if (activeIds) {
      workspaceList = workspaceList.filter(w => activeIds.has(w.workspace_id))
    }

    // The inclusive list of YYYY-MM-DD strings in the requested window. Defined
    // up front so the live-fill below knows exactly which cells to check.
    const dates = enumerateDates(start, end, 400)

    // Query perf_cache_daily for the date range. Read saved_at so we can tell a
    // REAL fetched row from a seeded-zero placeholder (saved_at=0) or a stale
    // 'today' row — those must be live-filled from PV, not trusted.
    const perfRes = await pool.query(
      `SELECT ws_id, date, data, saved_at
       FROM perf_cache_daily
       WHERE date >= $1 AND date <= $2
       ORDER BY date ASC`,
      [start, end]
    )

    const perfByDateAndWs: Record<string, Record<string, Record<string, number>>> = {}
    const savedAt: Record<string, Record<string, number>> = {}
    ;(perfRes.rows as Array<{ ws_id: string; date: string; data: Record<string, number> | null; saved_at: string | number | null }>).forEach(row => {
      if (!perfByDateAndWs[row.ws_id]) { perfByDateAndWs[row.ws_id] = {}; savedAt[row.ws_id] = {} }
      perfByDateAndWs[row.ws_id][row.date] = row.data || {}
      savedAt[row.ws_id][row.date] = Number(row.saved_at) || 0
    })

    // LIVE-FILL: for every active workspace×date whose row is MISSING, seeded-
    // zero (saved_at=0), or a STALE 'today' row, fetch it directly from PlusVibe
    // now. This is the correctness guarantee: the dashboard equals live PV even
    // if the background warm hasn't run / lost the race. Bounded + time-boxed.
    {
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
      // PRIORITY 1: TODAY for every active workspace — the contested, climbing
      // day that other writers corrupt. Always refetched (never trust cache).
      // PRIORITY 2: missing/seeded PAST days — but only a small cap, so a wide
      // 30D/90D range doesn't fan out to hundreds of blocking PV calls (which
      // made the page hang / time out). Remaining gaps warm in the background.
      const todayGaps: { ws: string; date: string }[] = []
      const pastGaps: { ws: string; date: string }[] = []
      for (const ws of workspaceList) {
        for (const date of dates) {
          if (date === todayStr) {
            // Only refetch today when the cached cell is actually stale. It used
            // to refetch unconditionally for EVERY workspace, which — behind a
            // 1-at-a-time PV gate with a 400ms floor — needs ~15-20s for a full
            // client list and could never finish inside the budget. The cells
            // then stayed at 0 and the page showed no sends on a day that had
            // them. A warm cell written seconds ago by the background warmer is
            // better than a zero.
            const sa = savedAt[ws.workspace_id]?.[date] ?? 0
            const cached = perfByDateAndWs[ws.workspace_id]?.[date]
            const fresh = sa > 0 && Date.now() - sa < TODAY_TTL_MS
            if (!cached || !fresh) todayGaps.push({ ws: ws.workspace_id, date })
            continue
          }
          const sa = savedAt[ws.workspace_id]?.[date]
          const missing = perfByDateAndWs[ws.workspace_id]?.[date] === undefined
          const seeded = sa === 0
          if (missing || seeded) pastGaps.push({ ws: ws.workspace_id, date })
        }
      }
      // Cap total inline fetches and time-box the whole pass so the request
      // always returns quickly. Today first; backfill past days with the budget.
      const MAX_INLINE = 64
      // Today's cells are what the default view renders, so they get the whole
      // budget first; past days only use what is left over. Mixing them let a
      // wide range spend the budget on backfill and return today as 0.
      const gaps = [...todayGaps, ...pastGaps].slice(0, MAX_INLINE)
      // Enough for a full client list at ~400ms/call serialized. The old 4s
      // wall was shorter than one complete pass, so today never resolved.
      const BUDGET_MS = Number(process.env.STATS_LIVEFILL_BUDGET_MS ?? 12000)
      if (gaps.length) {
        // The fan-out is raced against a single wall clock rather than checked
        // only BETWEEN batches. pvFetch serializes on a global gate
        // (PV_CONCURRENCY=1) and retries 429/5xx with backoff, so one batch can
        // run for MINUTES — a between-batches check never gets to fire and the
        // page hung forever on any range containing today. Whatever has landed
        // when the budget expires is used; the rest stays cached/background-warmed.
        const budget = new Promise<void>(r => setTimeout(r, BUDGET_MS))
        const CONC = 8
        const fanOut = (async () => {
          for (let i = 0; i < gaps.length; i += CONC) {
            await Promise.allSettled(
              gaps.slice(i, i + CONC).map(async ({ ws, date }) => {
                const data = await fetchPvDay(ws, date)
                if (!data) return
                if (!perfByDateAndWs[ws]) perfByDateAndWs[ws] = {}
                perfByDateAndWs[ws][date] = data
                void upsertPerfDay(ws, date, data) // warm the cache for next read
              }),
            )
          }
        })()
        // Never let a rejection escape; we only care that one of the two settles.
        await Promise.race([fanOut.catch(() => {}), budget])
      }
    }

    // Leads are counted from esp_leads (label='INTERESTED') — the table the
    // Unibox writes to when a reply is marked as a lead. PlusVibe itself does
    // NOT show these as leads, so the old revenue_leads (PV-sourced) count
    // missed Unibox-marked leads (e.g. LVM showed replies but 0 leads). Window
    // on the lead date = COALESCE(first_replied_at, created_at, synced_at), so
    // RTL/LPT share the same period as their denominators.
    const leadsRes = await pool.query(
      `SELECT workspace_id, COUNT(*)::int AS n
       FROM esp_leads
       WHERE label = 'INTERESTED'
         AND COALESCE(first_replied_at, created_at, synced_at)::date >= $1::date
         AND COALESCE(first_replied_at, created_at, synced_at)::date <= $2::date
       GROUP BY workspace_id`,
      [start, end],
    )
    const leadsByWs: Record<string, number> = {}
    ;(leadsRes.rows as Array<{ workspace_id: string; n: number }>).forEach(r => {
      leadsByWs[r.workspace_id] = r.n
    })

    // REPLIES from OUR unibox, counted by WHAT THE REPLY IS — not just "not warm-up"
    // (that swept in inbound spam-to-mailbox / junk filed as 'other' and inflated
    // the numbers). HUMAN = a genuine response (interested/question/not_interested/
    // unsubscribe). OOO = ooo_auto_reply. 'other' and warm-up never count.
    const uniRepliesRes = await pool.query(
      `SELECT workspace_id,
              COUNT(DISTINCT lower(lead_email)) FILTER (
                WHERE COALESCE(admin_label, category) IN ('interested','question','not_interested','unsubscribe')
              )::int AS human,
              COUNT(DISTINCT lower(lead_email)) FILTER (
                WHERE COALESCE(admin_label, category) = 'ooo_auto_reply'
              )::int AS ooo
         FROM unibox_replies
        WHERE received_at::date >= $1::date AND received_at::date <= $2::date
        GROUP BY workspace_id`,
      [start, end],
    )
    const uniByWs: Record<string, { human: number; ooo: number }> = {}
    ;(uniRepliesRes.rows as Array<{ workspace_id: string; human: number; ooo: number }>).forEach(r => {
      uniByWs[r.workspace_id] = { human: Number(r.human) || 0, ooo: Number(r.ooo) || 0 }
    })

    // Build per-workspace stats
    const workspaces: Workspace[] = []
    for (const ws of workspaceList) {
      const series: DayData[] = []
      const totals = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, contacted: 0, leads: 0 }

      for (const date of dates) {
        const dayData = perfByDateAndWs[ws.workspace_id]?.[date] || {}
        const day: DayData = {
          date,
          sent: Number(dayData.sent) || 0,
          replies: Number(dayData.replies) || 0,
          posReplies: Number(dayData.posReplies) || 0,
          oooReplies: Number(dayData.oooReplies) || 0,
          bounces: Number(dayData.bounces) || 0,
          // People contacted (LPT denominator). Older cache rows predate this
          // field; fall back to sent so LPT degrades gracefully, not to 0.
          contacted: Number(dayData.contacted ?? dayData.sent) || 0,
          leads: 0, // leads filled from revenue_leads below, not the perf cache
        }
        series.push(day)
        totals.sent += day.sent
        totals.replies += day.replies
        totals.posReplies += day.posReplies
        totals.oooReplies += day.oooReplies
        totals.bounces += day.bounces
        totals.contacted += day.contacted
      }
      // Leads = frozen revenue_leads count for this workspace in-window.
      totals.leads = leadsByWs[ws.workspace_id] || 0
      // Replies (Human RR) = genuine human responses from the unibox; OOO is its
      // own bucket (feeds Reply Rate w/OOO). GREATER of PV vs unibox so we never
      // under-report. 'other'/spam excluded — that was the inflation.
      const u = uniByWs[ws.workspace_id]
      if (u) {
        totals.replies = Math.max(totals.replies, u.human)
        totals.oooReplies = Math.max(totals.oooReplies, u.ooo)
      }

      const days = dates.length || 1
      const w: Workspace = {
        workspace_id: ws.workspace_id,
        name: ws.workspace_name || ws.workspace_id,
        totals: {
          ...totals,
          // PROVEN via live PlusVibe (reconcile ?live=1): total_reply_count is
          // the HUMAN/non-OOO count and total_ooo_reply_count is a SEPARATE
          // bucket — live shows replies(6) < ooo(34), impossible if it included
          // OOO. So:
          //   Human RR           = replies / sent
          //   Reply Rate (w/OOO) = (replies + ooo) / sent
          replyRate: totals.sent > 0 ? totals.replies / totals.sent : 0,
          allReplyRate:
            totals.sent > 0 ? (totals.replies + totals.oooReplies) / totals.sent : 0,
          bounceRate: totals.sent > 0 ? totals.bounces / totals.sent : 0,
          // RTL = Replies-To-Lead: human replies per lead. `replies` is already
          // the human count (OOO is separate), so RTL = replies / leads.
          rtl: totals.leads > 0 ? totals.replies / totals.leads : 0,
          // LPT = Contacts-To-Lead: how many people contacted per lead
          // (contacted ÷ leads). Lower is better. 'contacted' is people emailed
          // (PV total_contacted_count), NOT total emails sent.
          lpt: totals.leads > 0 ? totals.contacted / totals.leads : 0,
          sendsPerDay: totals.sent / days,
          repliesPerDay: totals.replies / days,
        },
        series,
      }

      // Only include if has data
      if (w.totals.sent > 0 || w.totals.leads > 0) {
        workspaces.push(w)
      }
    }

    // Sort by reply volume descending
    workspaces.sort((a, b) => b.totals.replies - a.totals.replies)

    return NextResponse.json({
      workspaces,
      dates,
      start,
      end,
      partial: false,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    // Capture to Sentry (not a silent console.error) and return an informative
    // message the page can surface — never a blank "no data".
    Sentry.captureException(err, { tags: { tag: 'stats/summary' }, extra: { start, end } })
    const msg = err instanceof Error ? err.message : 'Failed to fetch stats'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
