import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import '@/lib/cache-warming' // Initialize cache warming on first import

interface DayData {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
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
    leads: number
    replyRate: number
    allReplyRate: number
    bounceRate: number
    rtl: number
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

    // Leads come from revenue_leads (the FROZEN source of truth) — NOT the perf
    // cache, which never carried lead data (all zeros). Shown ALL-TIME per
    // workspace (a delivered lead counts regardless of the stats window; the
    // cutover only applies to email-activity stats). Excludes non-leads.
    const leadsRes = await pool.query(
      `SELECT workspace_id, COUNT(*)::int AS n
       FROM revenue_leads
       WHERE pv_nonlead IS NOT TRUE
       GROUP BY workspace_id`,
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
      const totals = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: 0 }

      for (const date of dates) {
        const dayData = perfByDateAndWs[ws.workspace_id]?.[date] || {}
        const day: DayData = {
          date,
          sent: Number(dayData.sent) || 0,
          replies: Number(dayData.replies) || 0,
          posReplies: Number(dayData.posReplies) || 0,
          oooReplies: Number(dayData.oooReplies) || 0,
          bounces: Number(dayData.bounces) || 0,
          leads: 0, // leads filled from revenue_leads below, not the perf cache
        }
        series.push(day)
        totals.sent += day.sent
        totals.replies += day.replies
        totals.posReplies += day.posReplies
        totals.oooReplies += day.oooReplies
        totals.bounces += day.bounces
      }
      // Leads = frozen revenue_leads count for this workspace in-window.
      totals.leads = leadsByWs[ws.workspace_id] || 0

      const days = dates.length || 1
      const w: Workspace = {
        workspace_id: ws.workspace_id,
        name: ws.workspace_name || ws.workspace_id,
        totals: {
          ...totals,
          // Human Reply Rate: genuine human replies only (warmup + OOO excluded).
          replyRate: totals.sent > 0 ? totals.replies / totals.sent : 0,
          // Reply Rate (all): human + OOO/automatic. Warmup never counted.
          allReplyRate: totals.sent > 0 ? (totals.replies + totals.oooReplies) / totals.sent : 0,
          bounceRate: totals.sent > 0 ? totals.bounces / totals.sent : 0,
          rtl: totals.replies > 0 ? totals.leads / totals.replies : 0,
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
