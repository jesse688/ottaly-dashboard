import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { getActiveWorkspaceIds } from '@/lib/active-clients'
import '@/lib/cache-warming' // Initialize cache warming on first import

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
const STATS_CUTOVER = process.env.STATS_CUTOVER_DATE ?? '2026-06-19'

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

    // Query perf_cache_daily for the date range
    const perfRes = await pool.query(
      `SELECT ws_id, date, data
       FROM perf_cache_daily
       WHERE date >= $1 AND date <= $2
       ORDER BY date ASC`,
      [start, end]
    )

    const perfByDateAndWs: Record<string, Record<string, Record<string, number>>> = {}
    ;(perfRes.rows as Array<{ ws_id: string; date: string; data: Record<string, number> | null }>).forEach(row => {
      if (!perfByDateAndWs[row.ws_id]) perfByDateAndWs[row.ws_id] = {}
      perfByDateAndWs[row.ws_id][row.date] = row.data || {}
    })

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

    // Generate date list
    const dates = []
    const current = new Date(start + 'T00:00:00Z')
    const endDate = new Date(end + 'T00:00:00Z')
    while (current <= endDate) {
      dates.push(current.toISOString().slice(0, 10))
      current.setDate(current.getDate() + 1)
    }

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

      const days = dates.length || 1
      const w: Workspace = {
        workspace_id: ws.workspace_id,
        name: ws.workspace_name || ws.workspace_id,
        totals: {
          ...totals,
          // PV exposes 3 reply columns: "Reply Rate (w/OOO)", "Reply Rate"
          // (human), "Positive Replies". Mapping to PV's fields:
          //   total_reply_count      = ALL replies incl OOO  → "w/OOO"
          //   total_ooo_reply_count  = the OOO subset
          //   human = total_reply_count − total_ooo_reply_count
          // Verified vs AccrueAccounting (PV w/OOO 3.4%, human 1.4%, sent 295):
          //   replies≈10 → 10/295=3.4% ✓ ; human=10−6=4 → 4/295=1.4% ✓
          //   Human RR           = (replies − ooo) / sent
          //   Reply Rate (w/OOO) = replies / sent
          replyRate:
            totals.sent > 0 ? Math.max(0, totals.replies - totals.oooReplies) / totals.sent : 0,
          allReplyRate: totals.sent > 0 ? totals.replies / totals.sent : 0,
          bounceRate: totals.sent > 0 ? totals.bounces / totals.sent : 0,
          // RTL = Replies-To-Lead: human replies it took to land one lead
          // (human replies ÷ leads, OOO excluded). Lower is better.
          rtl:
            totals.leads > 0
              ? Math.max(0, totals.replies - totals.oooReplies) / totals.leads
              : 0,
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
