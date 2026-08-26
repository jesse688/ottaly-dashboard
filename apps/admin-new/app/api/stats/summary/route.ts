import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { getActiveWorkspaceIds } from '@/lib/active-clients'
import {
  fetchPvRange,
  readRangeCache,
  writeRangeCache,
  refreshRangeInBackground,
  type PvDay,
  type PvRange,
} from '@/lib/pv-range'

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
  // ALL TIME is an explicit request for everything, including the Bison era, so
  // it is NOT clamped to the PV cutover — it floors at the first day any mail
  // was actually sent (verified against PV: earliest non-zero send is
  // 2026-03-20). Every other range still clamps to the cutover so it stays
  // PV-clean. The period filter sends 0000-01-01 for All Time.
  const ALL_TIME_FLOOR = process.env.STATS_ALL_TIME_FLOOR ?? '2026-03-20'
  // ALL TIME is the SENTINEL the period filter sends ('0000-01-01'), not merely
  // "a date before the floor". Testing `rawStart < ALL_TIME_FLOOR` also matched
  // This Year (2026-01-01), so This Year silently resolved to All Time and
  // included Bison-era sending — measured live: it started 2026-03-20 instead
  // of the cutover. Anything that is not the sentinel clamps to the cutover.
  const isAllTime = rawStart <= '1900-01-01'
  const start = isAllTime
    ? ALL_TIME_FLOOR
    : rawStart < STATS_CUTOVER
      ? STATS_CUTOVER
      : rawStart

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

    // Cap high enough for All Time (2026-03-20 onwards is ~2,400 days and grows).
    // The old 400 would have silently truncated the chart on that range.
    const dates = enumerateDates(start, end, 4000)

    // ── THE SOURCE OF TRUTH, SERVED FROM CACHE ───────────────────────────────
    // Every number still comes from ONE PV response per workspace, so the
    // numerator and denominator can never be measured over different windows —
    // that is the accuracy property this page was fixed for.
    //
    // But the page must NEVER wait on PlusVibe. pvFetch shares one process-wide
    // gate (PV_CONCURRENCY=1, 400ms floor) with the background cache warmer,
    // which fires up to 40 calls every 2 minutes. Calling PV inline queued the
    // request behind that backlog and a single workspace timed out at 100s.
    //
    // So: read the range cache, serve whatever is there, and refresh stale or
    // missing rows in the BACKGROUND. A cold range blocks only for a small,
    // strictly time-boxed number of workspaces so the first ever view is not
    // empty; everything else fills in and appears on the next load.
    const wsIds = workspaceList.map(w => w.workspace_id)
    const cached = await readRangeCache(wsIds, start, end)

    const byWs = new Map<string, PvRange>()
    const missing: string[] = []
    let servedStale = 0
    let oldestSavedAt = 0

    for (const id of wsIds) {
      const hit = cached.get(id)
      if (!hit) { missing.push(id); continue }
      byWs.set(id, hit.range)
      if (hit.stale) {
        servedStale++
        refreshRangeInBackground(id, start, end) // returns immediately
      }
      if (hit.savedAt && (oldestSavedAt === 0 || hit.savedAt < oldestSavedAt)) {
        oldestSavedAt = hit.savedAt
      }
    }

    // COLD START: fetch a few missing workspaces inline, under a hard wall, so
    // a never-before-viewed range shows something rather than an empty page.
    // The rest are refreshed in the background and land on a later load.
    const failed: string[] = []
    if (missing.length) {
      const MAX_INLINE = Number(process.env.STATS_COLD_INLINE ?? 25)
      const BUDGET_MS = Number(process.env.STATS_COLD_BUDGET_MS ?? 25000)
      const inline = missing.slice(0, MAX_INLINE)

      // Issue all of them at once. pvGate still serialises the wire and holds
      // the 400ms floor, so PV sees the same rate — but the calls are queued as
      // PRIORITY, so they drain ahead of the warmers instead of one-at-a-time
      // behind them. ~25 workspaces x ~0.5s is comfortably inside the budget.
      const work = Promise.all(
        inline.map(async id => {
          const range = await fetchPvRange(id, start, end)
          if (range) {
            byWs.set(id, range)
            void writeRangeCache(id, start, end, range)
          }
        }),
      ).then(() => undefined)
      // Race the whole pass against one wall clock. pvFetch can sit in backoff
      // for minutes, so a per-item check would never fire — that is exactly how
      // the page hung before.
      await Promise.race([work.catch(() => {}), new Promise(r => setTimeout(r, BUDGET_MS))])

      // Anything still absent is UNKNOWN, not zero, and is queued for later.
      for (const id of missing) {
        if (!byWs.has(id)) {
          failed.push(id)
          refreshRangeInBackground(id, start, end)
        }
      }
    }

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

      // A workspace that sent mail but reports NO denominator cannot produce a
      // rate. Treat it as a failure rather than silently rendering 0% — a
      // missing denominator is exactly what broke this page: the field name
      // differed between the MCP and the public API, the divisor was 0, and the
      // zero propagated as if it were real.
      if (t.sent > 0 && t.contacted <= 0) {
        console.error(
          `[stats] ${ws.workspace_name || ws.workspace_id}: sent=${t.sent} but contacted=${t.contacted} — no denominator, skipping`,
        )
        failedNames.push(ws.workspace_name || ws.workspace_id)
        failed.push(ws.workspace_id)
        continue
      }

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
          //   Human RR           = replies / contacted
          //   Reply Rate (w/OOO) = (replies + ooo) / contacted
          // `contacted` is the public API's total_contacted_count — see the
          // note in lib/pv-range.ts. Bounce is the exception and divides by sent.
          replyRate: t.contacted > 0 ? t.replies / t.contacted : 0,
          allReplyRate:
            t.contacted > 0 ? (t.replies + t.oooReplies) / t.contacted : 0,
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
      // True when the window predates the PV cutover, i.e. it spans the
      // Bison->PlusVibe migration. The page labels it so the number is never
      // mistaken for PlusVibe-only performance.
      spansBison: isAllTime,
      // How many rows were served from a cache older than its TTL, and the age
      // of the oldest one, so the page can say how fresh the numbers are
      // instead of implying they are live to the second.
      stale: servedStale,
      dataAsOf: oldestSavedAt ? new Date(oldestSavedAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'stats/summary' }, extra: { start, end } })
    const msg = err instanceof Error ? err.message : 'Failed to fetch stats'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
