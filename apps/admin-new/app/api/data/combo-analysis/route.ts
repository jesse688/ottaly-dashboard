import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { warmComboDates } from '@/lib/cache-warming'

// ── Combo Analysis (sender provider × recipient provider) ───────────────────
// MEASURED per combo. Reads combo_daily_stats, which the cache-warmer fills from
// PlusVibe /account/email-stats with provider + recp_provider filters (verified
// to segment exactly: unfiltered total = Σ provider buckets = Σ recp_provider
// buckets). Every sent/reply/OOO/bounce number is a real PV figure for that
// exact (sender ESP × recipient ESP) cell — NO apportioning, NO webhook-partial
// email_events. Leads still come from unibox_replies (marked_as_lead), which is
// the classified lead source; PV email-stats doesn't carry lead counts.

export const dynamic = 'force-dynamic'

// PV ESP codes → the from_type / to_type strings the page's label maps expect.
const SENDER_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'google',
  MICROSOFT365: 'microsoft',
  REGULAR_ACCOUNT: 'smtp',
}
const RECIP_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'email_google',
  MICROSOFT365: 'email_outlook',
  REGULAR_ACCOUNT: 'email_other',
}
// unibox mx_provider values → same recipient buckets, for the leads join.
const MX_TO_RECIP: Record<string, string> = {
  email_google: 'email_google',
  email_outlook: 'email_outlook',
  email_other: 'email_other',
}


// Mirror legacy clampStartDate(): when "show historical" is off and a
// fresh_start_date is set, never query earlier than that date.
async function clampStartDate(startStr: string): Promise<string> {
  if (!startStr) return startStr
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT value FROM app_settings WHERE key = 'fresh_start_date') AS fresh,
         (SELECT value FROM app_settings WHERE key = 'show_historical')  AS show_hist`
    )
    const fresh = rows[0]?.fresh
    const showHist = rows[0]?.show_hist
    const freshDate = typeof fresh === 'string' ? fresh : fresh == null ? null : String(fresh)
    const showHistorical = showHist === true
    if (showHistorical || !freshDate) return startStr
    return startStr < freshDate ? freshDate : startStr
  } catch {
    return startStr
  }
}

// Build the inclusive YYYY-MM-DD list between start and end (combo_daily_stats.date is TEXT).
function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  const d = new Date(start + 'T00:00:00Z')
  const last = new Date(end + 'T00:00:00Z')
  // guard against inverted / absurd ranges
  let guard = 0
  while (d <= last && guard++ < 400) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export async function GET(req: NextRequest) {
  const startRaw = String(req.nextUrl.searchParams.get('start') || '')
  const end = String(req.nextUrl.searchParams.get('end') || '')
  const workspaceId = String(req.nextUrl.searchParams.get('workspace_id') || '').trim()
  const start = await clampStartDate(startRaw)
  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

  const dates = dateRange(start, end)
  // Fill any stale/missing days for the requested window (TTL-guarded, cheap).
  await warmComboDates(dates).catch(() => {})

  // Immediately-preceding window of the same length, for week-over-week trend.
  // ESP matching is re-set weekly, so "is this combo better or worse than when
  // I last changed it" matters more than any single window's absolute rate.
  const spanDays = Math.max(1, dates.length)
  const prevEndD = new Date(Date.parse(start + 'T00:00:00Z') - 86_400_000)
  const prevStartD = new Date(prevEndD.getTime() - (spanDays - 1) * 86_400_000)
  const prevStart = prevStartD.toISOString().slice(0, 10)
  const prevEnd = prevEndD.toISOString().slice(0, 10)

  const wsCombo = workspaceId ? `AND ws_id = $3` : ''
  const wsUr = workspaceId ? `AND ur.workspace_id = $3` : ''

  try {
    // Measured combo cells — aggregate the JSONB across the window per (provider, recp_provider).
    // Exclude the '_'/'_' sentinel rows used only for freshness tracking.
    const { rows: comboRows } = await pool.query(
      `SELECT provider, recp_provider,
              SUM((data->>'sent')::int)       AS sent,
              SUM((data->>'replies')::int)    AS replies,
              SUM((data->>'oooReplies')::int) AS ooo,
              SUM((data->>'posReplies')::int) AS pos,
              SUM((data->>'bounces')::int)    AS bounces,
              SUM((data->>'contacted')::int)  AS contacted
         FROM combo_daily_stats
        WHERE date >= $1 AND date <= $2
          AND provider <> '_'
          ${wsCombo}
        GROUP BY provider, recp_provider`,
      workspaceId ? [start, end, workspaceId] : [start, end]
    )
    // Same shape for the preceding window. Read-only from cache — deliberately
    // NOT warmed, so opening the page never triggers a second PV fetch storm.
    // A prior window with no cached rows simply yields no trend arrows.
    const { rows: prevRows } = await pool.query(
      `SELECT provider, recp_provider,
              SUM((data->>'sent')::int)       AS sent,
              SUM((data->>'oooReplies')::int) AS ooo
         FROM combo_daily_stats
        WHERE date >= $1 AND date <= $2
          AND provider <> '_'
          ${wsCombo}
        GROUP BY provider, recp_provider`,
      workspaceId ? [prevStart, prevEnd, workspaceId] : [prevStart, prevEnd]
    )
    const prevByCombo = new Map<string, { sent: number; ooo: number }>()
    for (const p of prevRows) {
      const f = SENDER_LABEL[p.provider as string] || (p.provider as string)
      const t = RECIP_LABEL[p.recp_provider as string] || (p.recp_provider as string)
      prevByCombo.set(`${f}|${t}`, { sent: +p.sent || 0, ooo: +p.ooo || 0 })
    }
    // NOTE: new-lead / follow-up split is NOT computed here — PlusVibe's
    // total_new_lead_contacted_count is only meaningful over a multi-day window
    // (0 per-day) AND its stats API is very slow (~75s for one workspace's 9
    // combos). So the split is fetched ON DEMAND, per-workspace, by the separate
    // /new-lead-split route. This keeps the combo page fast.

    // Leads per (sender ESP × recipient ESP) from unibox_replies (marked_as_lead).
    // sender ESP ← receiving mailbox_meta.mailbox_type; recipient ESP ← contacts.mx_provider.
    const { rows: leadRows } = await pool.query(
      `WITH st AS (
         SELECT DISTINCT ON (lower(email)) lower(email) el, COALESCE(mailbox_type,'smtp') s
         FROM mailbox_meta ORDER BY lower(email)
       ),
       rt AS (
         SELECT DISTINCT ON (lower(email)) lower(email) el, mx_provider r
         FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
       )
       SELECT COALESCE(st.s,'smtp') AS sender_type,
              COALESCE(rt.r,'email_other') AS recip_type,
              COUNT(*)::int AS leads
       FROM unibox_replies ur
       LEFT JOIN st ON st.el = lower(ur.mailbox_email)
       LEFT JOIN rt ON rt.el = lower(COALESCE(ur.matched_lead_email, ur.lead_email))
       WHERE ur.marked_as_lead = TRUE
         AND ur.marked_at >= $1 AND ur.marked_at < ($2::date + interval '1 day')
         ${wsUr}
       GROUP BY 1, 2`,
      workspaceId ? [start, end, workspaceId] : [start, end]
    )
    // leads keyed by the page's from_type|to_type. mailbox_type is already
    // google/microsoft/smtp; mx_provider is already email_google/outlook/other.
    const leadByCombo = new Map<string, number>()
    for (const l of leadRows) {
      const from = (l.sender_type as string) || 'smtp'
      const to = MX_TO_RECIP[l.recip_type as string] || 'email_other'
      leadByCombo.set(`${from}|${to}`, (leadByCombo.get(`${from}|${to}`) || 0) + (+l.leads || 0))
    }

    const rows = comboRows
      .map((r) => {
        const from_type = SENDER_LABEL[r.provider as string] || (r.provider as string)
        const to_type = RECIP_LABEL[r.recp_provider as string] || (r.recp_provider as string)
        const sent = +r.sent || 0
        // PlusVibe field semantics (verified via PV's own computed rates):
        //   total_reply_count  = HUMAN replies (EXCLUDES OOO)
        //   total_ooo_reply_count = OOO / auto-replies (separate)
        // So reply-rate-incl-OOO = reply + ooo; human = reply.
        const human = +r.replies || 0 // stored from total_reply_count
        const ooo = +r.ooo || 0
        const repliesInclOoo = human + ooo
        return {
          from_type,
          to_type,
          sent,
          replies: repliesInclOoo,     // reply rate incl. OOO (human + OOO)
          replies_human: human,        // human reply rate (excludes OOO)
          ooo,                         // OOO/auto-replies alone — the infra signal
          prev_sent: prevByCombo.get(`${from_type}|${to_type}`)?.sent ?? 0,
          prev_ooo: prevByCombo.get(`${from_type}|${to_type}`)?.ooo ?? 0,
          pos_replies: +r.pos || 0,    // positive/interested
          bounces: +r.bounces || 0,
          leads: leadByCombo.get(`${from_type}|${to_type}`) || 0,
          unique_contacts: +r.contacted || 0,
          capped: false,               // measured cells: sent is the true denominator, never >100%
          is_approx: false,
        }
      })
      .filter((r) => r.sent > 0 || r.replies > 0 || r.leads > 0)
      .sort((a, b) => b.sent - a.sent)

    // Surface lead-only combos (leads whose sends fell outside the window / provider
    // combo had no cell) so the lead total stays honest.
    for (const [key, n] of leadByCombo) {
      const [from_type, to_type] = key.split('|')
      if (!rows.some((r) => r.from_type === from_type && r.to_type === to_type)) {
        rows.push({
          from_type, to_type, sent: 0, replies: 0, replies_human: 0, ooo: 0,
          prev_sent: 0, prev_ooo: 0,
          pos_replies: 0, bounces: 0, leads: n, unique_contacts: 0,
          capped: false, is_approx: false,
        })
      }
    }

    const totalSent = rows.reduce((s, r) => s + r.sent, 0)
    return NextResponse.json({
      rows,
      // Measured data is fully attributed; coverage is 100% of what PV reports.
      coverage: { total: totalSent, with_sender: totalSent },
      hasApprox: false,
      start,
      end,
      prev_start: prevStart,
      prev_end: prevEnd,
      source: 'combo_daily_stats (measured)',
    })
  } catch (err) {
    console.error('[combo-analysis]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 }
    )
  }
}
