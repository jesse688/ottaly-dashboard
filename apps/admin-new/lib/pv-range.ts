import { pvFetch } from './cache-warming'

// ─────────────────────────────────────────────────────────────────────────────
// PlusVibe range stats — THE source of truth for the Stats page.
//
// Why this exists: the page used to divide a FULL-WINDOW reply numerator (from
// our unibox) by a PARTIAL-WINDOW sent denominator (from perf_cache_daily,
// which had missing and seeded-zero days). Proven on ButterflyEco 2026-08-01..25:
// PV said 21,746 sent, the cache had 11,554 — six whole send-days were absent —
// so Human RR read 1.96% when the truth was 1.04%, and Reply Rate w/OOO read
// 9.86% against a true 4.94%. Everything was inflated ~2x.
//
// The fix is structural, not a bigger cache: ask PV for the WHOLE range in ONE
// call per workspace and take numerator and denominator from the SAME response.
// They then cannot disagree, whatever the cache is doing. PV returns the daily
// breakdown in the same payload, so the chart series comes from it too.
// ─────────────────────────────────────────────────────────────────────────────

export interface PvDay {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  contacted: number
  uniqueContacted: number
}

export interface PvRange {
  totals: Omit<PvDay, 'date'>
  series: PvDay[]
}

// PV's per-day chart entry. Only the fields we consume are named.
interface PvChartRow {
  date?: string
  total_sent_count?: number
  total_reply_count?: number
  total_ooo_reply_count?: number
  total_bounce_count?: number
  total_contacted_count?: number
  total_pos_reply_count?: number
  total_unique_contacted_count?: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Fetch one workspace's stats for an inclusive date range in a SINGLE PV call.
 *
 * Returns null on failure — callers MUST treat null as "unknown", never as
 * zero. A zero here would silently shrink the denominator and re-create exactly
 * the inflation bug this module was written to kill.
 */
export async function fetchPvRange(
  wsId: string,
  start: string,
  end: string,
): Promise<PvRange | null> {
  let raw: unknown
  try {
    raw = await pvFetch(
      `/account/email-stats?workspace_id=${encodeURIComponent(wsId)}` +
        `&start_date=${start}&end_date=${end}`,
    )
  } catch {
    return null
  }

  const body = raw as { header?: Record<string, unknown>; chart?: PvChartRow[] } | null
  const header = body?.header
  // No header = a shape we don't understand. Unknown, not zero.
  if (!header) return null

  // Totals come from PV's own header rather than a sum over `chart`, so they
  // match what PV's UI shows for the same range exactly.
  const totals = {
    sent: num(header.total_sent_count),
    replies: num(header.total_reply_count),
    posReplies: num(header.total_pos_reply_count),
    oooReplies: num(header.total_ooo_reply_count),
    bounces: num(header.total_bounce_count),
    // People contacted — the LPT denominator. This is NOT sent: over
    // 2026-08-01..25 ButterflyEco sent 21,746 emails to 17,509 people. The old
    // code fell back to `sent` whenever the cached row predated this field,
    // which quietly overstated LPT on every historic day.
    contacted: num(header.total_contacted_count),
    // Distinct people ever emailed in the window — and, verified below, the
    // denominator PV itself divides its reply rates by.
    //
    // Checked against PV's own published rates over three independent windows
    // (2026-06-17..08-26, 08-01..25, 06-01..30). Dividing by this reproduces
    // reply_rate and reply_rate_with_ooo EXACTLY every time
    // (1.21→1.2, 5.56→5.6 | 1.26→1.3, 6.00→6.0 | 1.05→1.0, 3.00→3.0),
    // whereas dividing by `sent` is low every time (0.99, 4.55 | 1.04, 4.94 |
    // 0.80, 2.30). Reply rates therefore use this; bounce_rate is the exception
    // and genuinely does divide by sent (0.58→0.6, 0.59→0.6, 0.45→0.4).
    uniqueContacted: num(header.total_unique_contacted_count),
  }

  const series: PvDay[] = (Array.isArray(body?.chart) ? body.chart : [])
    .filter((d): d is PvChartRow & { date: string } => typeof d?.date === 'string')
    .map(d => ({
      date: d.date,
      sent: num(d.total_sent_count),
      replies: num(d.total_reply_count),
      posReplies: num(d.total_pos_reply_count),
      oooReplies: num(d.total_ooo_reply_count),
      bounces: num(d.total_bounce_count),
      contacted: num(d.total_contacted_count),
      // PV omits the unique count per-day; only the header carries it. The
      // per-day series is used for the trend chart, whose rates are computed
      // from `sent`, so this is 0 here by design and never a hidden divisor.
      uniqueContacted: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { totals, series }
}

/**
 * Fetch many workspaces' ranges concurrently.
 *
 * `pvFetch` serialises on a process-wide gate and backs off on 429, so the
 * concurrency here only controls how many calls are queued, not the rate PV
 * actually sees. Failures are reported by workspace id rather than swallowed —
 * the route needs to know precisely which rows are untrustworthy so it can
 * refuse to print a rate for them.
 */
export async function fetchPvRanges(
  wsIds: string[],
  start: string,
  end: string,
): Promise<{ byWs: Map<string, PvRange>; failed: string[] }> {
  const byWs = new Map<string, PvRange>()
  const failed: string[] = []

  const CONC = 6
  for (let i = 0; i < wsIds.length; i += CONC) {
    const batch = wsIds.slice(i, i + CONC)
    const results = await Promise.allSettled(
      batch.map(async id => ({ id, range: await fetchPvRange(id, start, end) })),
    )
    for (const [j, r] of results.entries()) {
      if (r.status === 'fulfilled' && r.value.range) byWs.set(r.value.id, r.value.range)
      else failed.push(batch[j])
    }
  }

  return { byWs, failed }
}
