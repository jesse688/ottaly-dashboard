import { NextResponse } from 'next/server'
import pool from '@/lib/db'

/**
 * Resource Calc — per-client capacity vs. demand, over a selectable window.
 *
 * For each active client (portal_clients, joined on workspace_id) we pull the
 * live inputs and derive whether they are under-utilising their mailboxes or
 * need more of them to hit their lead target:
 *
 *   capacity/day   = SUM(mailbox_full.daily_limit)   -- max sending speed
 *   sent           = perf_cache_daily (windowed)      -- what they actually sent
 *   human_replies  = unibox_replies (windowed)        -- real human replies
 *   leads          = esp_leads INTERESTED (windowed)  -- actual leads delivered
 *   target         = portal_clients.monthly_lead_target (monthly; scaled to window)
 *
 * Window is ?days=7|30|60|90. All time-based metrics recompute to it and
 * capacity scales to it (capacity/day × days) so utilisation and expected
 * leads are apples-to-apples for the period.
 *
 * Data-depth caveat: perf_cache_daily + unibox_replies only hold ~30 days of
 * history, so for 60/90d windows the *sends/replies* are capped at what exists
 * (leads go back further). We surface SEND_DATA_DAYS so the UI can flag a
 * window as limited rather than showing misleadingly low volumes.
 */

const ALLOWED_WINDOWS = [7, 30, 60, 90] as const
type Window = (typeof ALLOWED_WINDOWS)[number]

// How far back sends/replies history actually reaches. Keep in sync with the
// oldest perf_cache_daily row; used to flag windows longer than this.
const SEND_DATA_DAYS = 30

type Row = {
  workspace_id: string
  company_name: string
  monthly_lead_target: number | null
  mailboxes: number
  capacity_per_day: number
  avg_limit: number
  sent: number
  human_replies: number
  human_replies_wide: number
  leads: number
  leads_wide: number
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const raw = Number(url.searchParams.get('days'))
    const days: Window = (ALLOWED_WINDOWS as readonly number[]).includes(raw)
      ? (raw as Window)
      : 30

    const { rows } = await pool.query<Row>(sqlForWindow(days))
    const clients = rows.map((r) => compute(r, days))
    return NextResponse.json({
      clients,
      days,
      sendDataDays: SEND_DATA_DAYS,
      sendDataLimited: days > SEND_DATA_DAYS, // 60/90d: sends/replies are capped
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[resource-calc]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

// Save an edited monthly target for one client.
export async function POST(req: Request) {
  try {
    const { workspace_id, monthly_lead_target } = await req.json()
    if (!workspace_id) {
      return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })
    }
    const target =
      monthly_lead_target === null || monthly_lead_target === ''
        ? null
        : Math.max(0, Math.round(Number(monthly_lead_target)))
    if (target !== null && !Number.isFinite(target)) {
      return NextResponse.json({ error: 'invalid target' }, { status: 400 })
    }
    await pool.query(
      `UPDATE portal_clients SET monthly_lead_target = $2 WHERE workspace_id = $1`,
      [workspace_id, target],
    )
    return NextResponse.json({ ok: true, monthly_lead_target: target })
  } catch (err) {
    console.error('[resource-calc:save]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

/**
 * Derive the calc for one client over a `days`-long window.
 */
function compute(r: Row, days: number) {
  const capacityPerDay = Number(r.capacity_per_day) || 0
  const capacityWindow = capacityPerDay * days // capacity scales to the window
  const sent = Number(r.sent) || 0
  const monthlyTarget = r.monthly_lead_target
  // Target is stored monthly; scale it to the window for a fair comparison.
  const windowTarget = monthlyTarget != null ? (monthlyTarget * days) / 30 : null

  // Avg daily sending over the window (what they're actually pushing per day).
  const avgDailySend = days > 0 ? sent / days : 0

  // Response rate (human) over the window.
  const responseRate = sent > 0 ? Number(r.human_replies) / sent : null

  // RTL: replies per lead, measured. Prefer the selected window; if too few
  // leads to be meaningful, widen to 90d so the conversion is still real.
  let rtl: number | null = null
  let rtlWindow: 'window' | '90d' | null = null
  if (r.leads >= 2 && r.human_replies > 0) {
    rtl = r.human_replies / r.leads
    rtlWindow = 'window'
  } else if (r.leads_wide >= 1 && r.human_replies_wide > 0) {
    rtl = r.human_replies_wide / r.leads_wide
    rtlWindow = '90d'
  }

  const utilisation = capacityWindow > 0 ? sent / capacityWindow : null

  // Expected leads if running at FULL capacity for the window.
  const expectedLeads =
    responseRate !== null && rtl && rtl > 0
      ? (capacityWindow * responseRate) / rtl
      : null

  const projectedLeads =
    responseRate !== null && rtl && rtl > 0 ? (sent * responseRate) / rtl : null

  // To hit the (windowed) target: sends needed, extra daily capacity, mailboxes.
  let sendsNeeded: number | null = null
  let capacityGapPerDay: number | null = null
  let mailboxesNeeded: number | null = null
  if (windowTarget && windowTarget > 0 && responseRate && responseRate > 0 && rtl && rtl > 0) {
    sendsNeeded = (windowTarget * rtl) / responseRate
    capacityGapPerDay = sendsNeeded / days - capacityPerDay
    const avgLimit = Number(r.avg_limit) || 0
    if (avgLimit > 0 && capacityGapPerDay > 0) {
      mailboxesNeeded = Math.ceil(capacityGapPerDay / avgLimit)
    }
  }

  const verdict = decide({
    target: windowTarget,
    rtl,
    responseRate,
    capacityWindow,
    expectedLeads,
    utilisation,
    mailboxesNeeded,
  })

  return {
    workspaceId: r.workspace_id,
    company: r.company_name,
    target: monthlyTarget, // echo the stored MONTHLY target for the editable cell
    mailboxes: Number(r.mailboxes) || 0,
    capacityPerDay,
    capacityWindow,
    avgLimit: Number(r.avg_limit) || 0,
    sent,
    avgDailySend,
    humanReplies: Number(r.human_replies) || 0,
    leads: Number(r.leads) || 0,
    responseRate,
    rtl,
    rtlWindow,
    utilisation,
    expectedLeads,
    projectedLeads,
    sendsNeeded,
    capacityGapPerDay,
    mailboxesNeeded,
    verdict,
  }
}

type VerdictInputs = {
  target: number | null
  rtl: number | null
  responseRate: number | null
  capacityWindow: number
  expectedLeads: number | null
  utilisation: number | null
  mailboxesNeeded: number | null
}

function decide(v: VerdictInputs): {
  code: 'no_target' | 'building' | 'under_utilised' | 'on_track' | 'needs_more'
  label: string
} {
  if (!v.target || v.target <= 0) return { code: 'no_target', label: 'Set a target' }
  if (v.rtl === null || v.responseRate === null || v.capacityWindow <= 0)
    return { code: 'building', label: 'Building history' }

  const expected = v.expectedLeads ?? 0
  const util = v.utilisation ?? 0

  if (expected < v.target * 0.95 && (v.mailboxesNeeded ?? 0) > 0) {
    return { code: 'needs_more', label: `Needs +${v.mailboxesNeeded} mailboxes` }
  }
  if (util < 0.85) {
    return { code: 'under_utilised', label: `Only ${Math.round(util * 100)}% of capacity used` }
  }
  return { code: 'on_track', label: 'On track' }
}

/**
 * One row per active client for a `days`-long window. `_wide` columns are the
 * 90-day figures used only as an RTL fallback when the window is too thin.
 */
function sqlForWindow(days: number) {
  // days is validated to the ALLOWED_WINDOWS set before this is called.
  return `
WITH cap AS (
  SELECT workspace_id,
         COUNT(*)                              AS mailboxes,
         COALESCE(SUM(daily_limit), 0)         AS capacity_per_day,
         COALESCE(ROUND(AVG(daily_limit)), 0)  AS avg_limit
  FROM mailbox_full
  WHERE daily_limit IS NOT NULL
  GROUP BY workspace_id
),
sent AS (
  SELECT ws_id AS workspace_id,
         COALESCE(SUM((data->>'sent')::int), 0) AS sent
  FROM perf_cache_daily
  WHERE date >= to_char(CURRENT_DATE - ${days}, 'YYYY-MM-DD')
  GROUP BY ws_id
),
repl AS (
  SELECT workspace_id,
         COUNT(DISTINCT lower(lead_email)) AS human_replies
  FROM unibox_replies
  WHERE received_at >= CURRENT_DATE - INTERVAL '${days} days'
    -- Human replies only: OOO auto-replies are excluded on purpose. They were
    -- 57-88% of counted replies and 3-5x inflated response rate & RTL.
    AND COALESCE(admin_label, category) IN
        ('interested','question','not_interested','unsubscribe')
  GROUP BY workspace_id
),
repl_wide AS (
  SELECT workspace_id,
         COUNT(DISTINCT lower(lead_email)) AS human_replies_wide
  FROM unibox_replies
  WHERE received_at >= CURRENT_DATE - INTERVAL '90 days'
    AND COALESCE(admin_label, category) IN
        ('interested','question','not_interested','unsubscribe')
  GROUP BY workspace_id
),
leads AS (
  SELECT workspace_id, COUNT(*) AS leads
  FROM esp_leads
  WHERE label = 'INTERESTED'
    AND COALESCE(first_replied_at, created_at) >= NOW() - INTERVAL '${days} days'
  GROUP BY workspace_id
),
leads_wide AS (
  SELECT workspace_id, COUNT(*) AS leads_wide
  FROM esp_leads
  WHERE label = 'INTERESTED'
    AND COALESCE(first_replied_at, created_at) >= NOW() - INTERVAL '90 days'
  GROUP BY workspace_id
)
SELECT
  pc.workspace_id,
  pc.company_name,
  pc.monthly_lead_target,
  COALESCE(cap.mailboxes, 0)            AS mailboxes,
  COALESCE(cap.capacity_per_day, 0)     AS capacity_per_day,
  COALESCE(cap.avg_limit, 0)            AS avg_limit,
  COALESCE(sent.sent, 0)               AS sent,
  COALESCE(repl.human_replies, 0)       AS human_replies,
  COALESCE(repl_wide.human_replies_wide, 0) AS human_replies_wide,
  COALESCE(leads.leads, 0)             AS leads,
  COALESCE(leads_wide.leads_wide, 0)    AS leads_wide
FROM portal_clients pc
LEFT JOIN cap        ON cap.workspace_id        = pc.workspace_id
LEFT JOIN sent       ON sent.workspace_id       = pc.workspace_id
LEFT JOIN repl       ON repl.workspace_id       = pc.workspace_id
LEFT JOIN repl_wide  ON repl_wide.workspace_id  = pc.workspace_id
LEFT JOIN leads      ON leads.workspace_id      = pc.workspace_id
LEFT JOIN leads_wide ON leads_wide.workspace_id = pc.workspace_id
WHERE pc.active = true
ORDER BY pc.company_name
`
}
