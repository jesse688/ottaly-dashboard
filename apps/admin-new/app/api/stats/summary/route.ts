import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { getActiveWorkspaceIds } from '@/lib/active-clients'
import { fetchPvRanges, type PvDay } from '@/lib/pv-range'

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
    uniqueContacted: number
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

// FRESH-START CUTOVER: PlusVibe-clean data begins here. Verified against PV on
// 2026-08-26: sending ran to 12 Jun, then stopped dead 13–21 Jun (0 sends except
// 19 on 15 Jun) and resumed 22 Jun. 2026-06-17 sits inside that dead zone, so
// the window is Bison-free without clipping any real PV send-day.
const STATS_CUTOVER = process.env.STATS_CUTOVER_DATE ?? '2026-06-17'

// Enumerate inclusive YYYY-MM-DD strings from start..end. Steps at UTC noon so
// DST can never drop or duplicate a day; the emitted strings are slices.
function enumerateDates(start: string, end: string, cap: number): string[] {
  const out: string[] = []
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
    const wsRes = await pool.query(
      `SELECT DISTINCT workspace_id, workspace_name
         FROM workspace_stats
        WHERE workspace_id IS NOT NULL AND workspace_id != ''
        ORDER BY workspace_id`,
    )
    let workspaceList = wsRes.rows as Array<{ workspace_id: string; workspace_name: string }>

    if (workspaceIds) {
      const ids = String(workspaceIds).split(',').filter(Boolean)
      workspaceList = workspaceList.filter(w => ids.includes(w.workspace_id))
    }

    // Hide inactive clients (legacy is the source of truth). Fails open: if the
    // status list is unavailable, show all rather than blank the page.
    const activeIds = await getActiveWorkspaceIds()
    if (activeIds) workspaceList = workspaceList.filter(w => activeIds.has(w.workspace_id))

    const dates = enumerateDates(start, end, 400)

    // ── THE SOURCE OF TRUTH ──────────────────────────────────────────────────
    // One PV call per workspace for the WHOLE range. Sent, replies, OOO,
    // bounces and contacted all come from the SAME response, so the numerator
    // and the denominator are always measured over the same days.
    //
    // The previous implementation read `sent` from perf_cache_daily and replies
    // from our unibox. When the cache was missing days — which it was, six of
    // them for ButterflyEco in August alone — the denominator shrank while the
    // numerator did not, and every rate on the page came out roughly double.
    // No cache-warming tweak can fix that; only sharing one source can.
    const { byWs, failed } = await fetchPvRanges(
      workspaceList.map(w => w.workspace_id),
      start,
      end,
    )

    // Leads are counted from esp_leads (label='INTERESTED') — the table the
    // Unibox writes to when a reply is marked as a lead. PlusVibe does NOT
    // expose these, so this stays our own. Windowed on the lead date so RTL and
    // LPT share the same period as their denominators.
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

    const workspaces: Workspace[] = []
    const failedNames: string[] = []

    for (const ws of workspaceList) {
      const range = byWs.get(ws.workspace_id)
      if (!range) {
        // Unknown, NOT zero. Recording zero here would shrink the agency-wide
        // denominator and inflate every headline rate — the exact failure mode
        // being fixed. Name it and leave it out of the maths entirely.
        failedNames.push(ws.workspace_name || ws.workspace_id)
        continue
      }

      // PV returns a row per day in range; index it so the series covers every
      // requested date even where PV omitted a silent day.
      const byDate = new Map<string, PvDay>()
      for (const d of range.series) byDate.set(d.date, d)

      const series: DayData[] = dates.map(date => {
        const d = byDate.get(date)
        return {
          date,
          sent: d?.sent ?? 0,
          replies: d?.replies ?? 0,
          posReplies: d?.posReplies ?? 0,
          oooReplies: d?.oooReplies ?? 0,
          bounces: d?.bounces ?? 0,
          contacted: d?.contacted ?? 0,
          leads: 0, // leads are a window total from esp_leads, not per-day
        }
      })

      const t = range.totals
      const leads = leadsByWs[ws.workspace_id] || 0
      const days = dates.length || 1

      const w: Workspace = {
        workspace_id: ws.workspace_id,
        name: ws.workspace_name || ws.workspace_id,
        totals: {
          sent: t.sent,
          replies: t.replies,
          posReplies: t.posReplies,
          oooReplies: t.oooReplies,
          bounces: t.bounces,
          contacted: t.contacted,
          uniqueContacted: t.uniqueContacted,
          leads,
          // PROVEN against live PV: total_reply_count is the HUMAN/non-OOO
          // count and total_ooo_reply_count is a SEPARATE bucket.
          //
          // The DENOMINATOR is unique-contacted, not sent. Verified against
          // PV's own published rates over three windows — dividing by
          // total_unique_contacted_count reproduces reply_rate and
          // reply_rate_with_ooo exactly (1.2/5.6, 1.3/6.0, 1.0/3.0), while
          // dividing by sent is low in all six cases. Using `sent` here is what
          // made a reply look rarer than PV reports it.
          //   Human RR           = replies / uniqueContacted
          //   Reply Rate (w/OOO) = (replies + ooo) / uniqueContacted
          // Bounce is the exception: it genuinely divides by sent.
          replyRate: t.uniqueContacted > 0 ? t.replies / t.uniqueContacted : 0,
          allReplyRate:
            t.uniqueContacted > 0 ? (t.replies + t.oooReplies) / t.uniqueContacted : 0,
          bounceRate: t.sent > 0 ? t.bounces / t.sent : 0,
          // RTL = human replies per lead.
          rtl: leads > 0 ? t.replies / leads : 0,
          // LPT = people contacted per lead. `contacted` is PV's
          // total_contacted_count (distinct people emailed), NOT emails sent.
          lpt: leads > 0 ? t.contacted / leads : 0,
          sendsPerDay: t.sent / days,
          repliesPerDay: t.replies / days,
        },
        series,
      }

      if (w.totals.sent > 0 || w.totals.leads > 0) workspaces.push(w)
    }

    workspaces.sort((a, b) => b.totals.replies - a.totals.replies)

    // `partial` is the page's instruction to HIDE rates rather than print a
    // number computed from an incomplete denominator.
    return NextResponse.json({
      workspaces,
      dates,
      start,
      end,
      partial: failed.length > 0,
      failedCount: failed.length,
      failedNames,
      source: 'plusvibe',
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'stats/summary' }, extra: { start, end } })
    const msg = err instanceof Error ? err.message : 'Failed to fetch stats'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
