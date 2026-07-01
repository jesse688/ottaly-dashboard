import { NextResponse } from 'next/server'
import pool from '@/lib/db'

/**
 * Resource Calc — per-client capacity vs. demand.
 *
 * For each active client (portal_clients, joined on workspace_id) we pull four
 * live inputs and derive whether they are under-utilising their mailboxes or
 * need more of them to hit their monthly lead target:
 *
 *   capacity/day   = SUM(mailbox_full.daily_limit)         -- max sending speed
 *   sent_30d       = perf_cache_daily                       -- what they actually sent
 *   human_replies  = unibox_replies (30d / 90d)             -- real human replies
 *   leads          = esp_leads INTERESTED (30d / 90d)       -- actual leads delivered
 *   target         = portal_clients.monthly_lead_target     -- editable on the page
 *
 * RTL (replies per lead) is measured, never invented: use the client's own
 * 30d ratio, and if they have <2 leads in 30d widen the RTL window to 90d so
 * the conversion is still real. If there is no lead history at all, we return
 * rtl = null and the UI shows "building history" instead of a fake verdict.
 */

// Rows are treated as one 30-day window; a mailbox sends ~this many days/month.
const DAYS = 30

type Row = {
  workspace_id: string
  company_name: string
  monthly_lead_target: number | null
  mailboxes: number
  capacity_per_day: number
  avg_limit: number
  sent_30d: number
  human_replies_30d: number
  human_replies_90d: number
  leads_30d: number
  leads_90d: number
}

export async function GET() {
  try {
    const { rows } = await pool.query<Row>(SQL)
    const clients = rows.map(compute)
    return NextResponse.json({ clients, generatedAt: new Date().toISOString() })
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
 * Derive the calc for one client. Pure function of the DB row so the logic is
 * easy to reason about and matches the numbers shown in the table.
 */
function compute(r: Row) {
  const capacityPerDay = Number(r.capacity_per_day) || 0
  const capacity30d = capacityPerDay * DAYS
  const sent = Number(r.sent_30d) || 0
  const target = r.monthly_lead_target

  // Response rate (human) over the last 30 days of sending.
  const responseRate = sent > 0 ? Number(r.human_replies_30d) / sent : null

  // RTL: replies per lead, measured from real data. Prefer 30d; if too few
  // leads to be meaningful, widen to 90d. null when there is no lead yet.
  let rtl: number | null = null
  let rtlWindow: '30d' | '90d' | null = null
  if (r.leads_30d >= 2 && r.human_replies_30d > 0) {
    rtl = r.human_replies_30d / r.leads_30d
    rtlWindow = '30d'
  } else if (r.leads_90d >= 1 && r.human_replies_90d > 0) {
    rtl = r.human_replies_90d / r.leads_90d
    rtlWindow = '90d'
  }

  // Utilisation: how much of their sending capacity are they actually using?
  const utilisation = capacity30d > 0 ? sent / capacity30d : null

  // Expected leads if they ran at FULL capacity with today's response rate & RTL.
  const expectedLeads =
    responseRate !== null && rtl && rtl > 0
      ? (capacity30d * responseRate) / rtl
      : null

  // What the current, actual send volume is producing (their real trajectory).
  const projectedLeads =
    responseRate !== null && rtl && rtl > 0 ? (sent * responseRate) / rtl : null

  // To hit target: sends needed, and the extra daily capacity / mailboxes.
  let sendsNeeded: number | null = null
  let capacityGapPerDay: number | null = null
  let mailboxesNeeded: number | null = null
  if (target && target > 0 && responseRate && responseRate > 0 && rtl && rtl > 0) {
    sendsNeeded = (target * rtl) / responseRate
    capacityGapPerDay = sendsNeeded / DAYS - capacityPerDay
    const avgLimit = Number(r.avg_limit) || 0
    if (avgLimit > 0 && capacityGapPerDay > 0) {
      mailboxesNeeded = Math.ceil(capacityGapPerDay / avgLimit)
    }
  }

  // Verdict — the point of the page.
  const verdict = decide({
    target,
    rtl,
    responseRate,
    capacity30d,
    expectedLeads,
    utilisation,
    mailboxesNeeded,
  })

  return {
    workspaceId: r.workspace_id,
    company: r.company_name,
    target,
    mailboxes: Number(r.mailboxes) || 0,
    capacityPerDay,
    capacity30d,
    avgLimit: Number(r.avg_limit) || 0,
    sent30d: sent,
    humanReplies30d: Number(r.human_replies_30d) || 0,
    leads30d: Number(r.leads_30d) || 0,
    responseRate,       // 0..1
    rtl,                // replies per lead, or null
    rtlWindow,
    utilisation,        // 0..1, or null
    expectedLeads,      // at full capacity
    projectedLeads,     // at current send volume
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
  capacity30d: number
  expectedLeads: number | null
  utilisation: number | null
  mailboxesNeeded: number | null
}

function decide(v: VerdictInputs): {
  code: 'no_target' | 'building' | 'under_utilised' | 'on_track' | 'needs_more'
  label: string
} {
  if (!v.target || v.target <= 0) return { code: 'no_target', label: 'Set a target' }
  if (v.rtl === null || v.responseRate === null || v.capacity30d <= 0)
    return { code: 'building', label: 'Building history' }

  const expected = v.expectedLeads ?? 0
  const util = v.utilisation ?? 0

  // Can full capacity even reach the target? If not, they need more mailboxes.
  if (expected < v.target * 0.95 && (v.mailboxesNeeded ?? 0) > 0) {
    return { code: 'needs_more', label: `Needs +${v.mailboxesNeeded} mailboxes` }
  }
  // Capacity is enough for the target, but they aren't sending near capacity.
  if (util < 0.85) {
    return { code: 'under_utilised', label: `Only ${Math.round(util * 100)}% of capacity used` }
  }
  return { code: 'on_track', label: 'On track' }
}

// One row per active client. LEFT JOINs so a client with no sends/leads still
// appears (verdict handles the thin-data case).
const SQL = `
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
         COALESCE(SUM((data->>'sent')::int), 0) AS sent_30d
  FROM perf_cache_daily
  WHERE date >= to_char(CURRENT_DATE - 30, 'YYYY-MM-DD')
  GROUP BY ws_id
),
repl30 AS (
  SELECT workspace_id,
         COUNT(DISTINCT lower(lead_email)) AS human_replies_30d
  FROM unibox_replies
  WHERE received_at >= CURRENT_DATE - INTERVAL '30 days'
    AND COALESCE(admin_label, category) IN
        ('interested','question','not_interested','unsubscribe','ooo_auto_reply')
  GROUP BY workspace_id
),
repl90 AS (
  SELECT workspace_id,
         COUNT(DISTINCT lower(lead_email)) AS human_replies_90d
  FROM unibox_replies
  WHERE received_at >= CURRENT_DATE - INTERVAL '90 days'
    AND COALESCE(admin_label, category) IN
        ('interested','question','not_interested','unsubscribe','ooo_auto_reply')
  GROUP BY workspace_id
),
leads30 AS (
  SELECT workspace_id, COUNT(*) AS leads_30d
  FROM esp_leads
  WHERE label = 'INTERESTED'
    AND COALESCE(first_replied_at, created_at) >= NOW() - INTERVAL '30 days'
  GROUP BY workspace_id
),
leads90 AS (
  SELECT workspace_id, COUNT(*) AS leads_90d
  FROM esp_leads
  WHERE label = 'INTERESTED'
    AND COALESCE(first_replied_at, created_at) >= NOW() - INTERVAL '90 days'
  GROUP BY workspace_id
)
SELECT
  pc.workspace_id,
  pc.company_name,
  pc.monthly_lead_target,
  COALESCE(cap.mailboxes, 0)         AS mailboxes,
  COALESCE(cap.capacity_per_day, 0)  AS capacity_per_day,
  COALESCE(cap.avg_limit, 0)         AS avg_limit,
  COALESCE(sent.sent_30d, 0)         AS sent_30d,
  COALESCE(repl30.human_replies_30d, 0) AS human_replies_30d,
  COALESCE(repl90.human_replies_90d, 0) AS human_replies_90d,
  COALESCE(leads30.leads_30d, 0)     AS leads_30d,
  COALESCE(leads90.leads_90d, 0)     AS leads_90d
FROM portal_clients pc
LEFT JOIN cap     ON cap.workspace_id     = pc.workspace_id
LEFT JOIN sent    ON sent.workspace_id    = pc.workspace_id
LEFT JOIN repl30  ON repl30.workspace_id  = pc.workspace_id
LEFT JOIN repl90  ON repl90.workspace_id  = pc.workspace_id
LEFT JOIN leads30 ON leads30.workspace_id = pc.workspace_id
LEFT JOIN leads90 ON leads90.workspace_id = pc.workspace_id
WHERE pc.active = true
ORDER BY pc.company_name
`
