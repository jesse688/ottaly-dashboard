import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { legacyFetch } from '@/lib/api'
import { evaluate, monthClock, type TriageInput, type TriageResult } from '@/lib/triage'

// CM Triage — ranked "who needs work now" worklist.
//
// Pulls each client's live levers from workspace_stats (target, LPT, capacity,
// data-on-hand, last-sent), month-to-date qualified leads from revenue_leads
// (same non-lead exclusion the revenue rollups use), and CM assignments from the
// legacy client_managers store, then runs the pure projection in lib/triage.
//
// Everything is keyed by workspace_id, the join key across all three sources.

interface StatsRow {
  workspace_id: string
  workspace_name: string
  client_status: string | null
  lead_target_monthly: number | null
  lpt_30d: number | null
  lpt_90d: number | null
  lpt_365d: number | null
  reply_rate_30d: number | null
  reply_rate_90d: number | null
  mailbox_count: number | null
  avg_daily_per_mailbox: number | null
  contacts_total: number | null
  contacts_interested: number | null
  contacts_replied: number | null
  contacts_bounced: number | null
  last_sent_at: string | null
}

interface Assignment {
  client_workspace_id: string
  manager_name: string
}

export async function GET() {
  try {
    const now = new Date()
    const { monthStart } = monthClock(now)

    // 1. Live levers per workspace, straight from the persisted stats blob.
    //    contacts_by_status is a nested object; pull the buckets we net out of
    //    "data on hand" (already-actioned contacts aren't sendable audience).
    const statsQ = pool.query<StatsRow>(
      `SELECT
         ws.workspace_id,
         ws.workspace_name,
          ws.stats->>'client_status'                              AS client_status,
         (ws.stats->>'lead_target_monthly')::int                 AS lead_target_monthly,
         (ws.stats->>'lpt_30d')::numeric                          AS lpt_30d,
         (ws.stats->>'lpt_90d')::numeric                          AS lpt_90d,
         (ws.stats->>'lpt_365d')::numeric                         AS lpt_365d,
         (ws.stats->>'reply_rate_30d')::numeric                   AS reply_rate_30d,
         (ws.stats->>'reply_rate_90d')::numeric                   AS reply_rate_90d,
         (ws.stats->>'mailbox_count')::int                        AS mailbox_count,
         (ws.stats->>'avg_daily_per_mailbox')::numeric            AS avg_daily_per_mailbox,
         (ws.stats->>'contacts_total')::int                       AS contacts_total,
         (ws.stats->'contacts_by_status'->>'interested')::int     AS contacts_interested,
         (ws.stats->'contacts_by_status'->>'replied')::int        AS contacts_replied,
         (ws.stats->'contacts_by_status'->>'bounced')::int        AS contacts_bounced,
         -- "Is the client sending?" ground truth = the most recent per-contact
         -- last_emailed_at, NOT the stats blob's last_sent_at. The blob field is
         -- stale/blank for most workspaces (the stats sync stopped populating it
         -- after the move to PlusVibe), which falsely flagged actively-sending
         -- clients as NOT_SENDING. contacts.last_emailed_at is refreshed live, so
         -- prefer it and fall back to the blob only when there are no contacts.
         COALESCE(
           to_char(c.max_last_emailed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           ws.stats->>'last_sent_at'
         )                                                        AS last_sent_at
       FROM workspace_stats ws
       LEFT JOIN (
         SELECT workspace_id, MAX(last_emailed_at) AS max_last_emailed
         FROM contacts
         GROUP BY workspace_id
       ) c ON c.workspace_id = ws.workspace_id`,
    )

    // 2. Month-to-date qualified leads per workspace (revenue_leads.date is
    //    'YYYY-MM-DD' TEXT — lexical >= monthStart is a valid month filter).
    //    Mirrors the exclusion used by /api/revenue/stats-by-workspace.
    const mtdQ = pool.query<{ workspace_id: string; leads: string }>(
      `SELECT workspace_id, COUNT(*)::int AS leads
         FROM revenue_leads
        WHERE pv_nonlead IS NOT TRUE
          AND UPPER(COALESCE(label, '')) NOT IN ('NON_LEAD', 'NONLEAD', 'NON LEAD')
          AND date >= $1
        GROUP BY workspace_id`,
      [monthStart],
    )

    // 3. CM assignments (manager↔client) from the legacy junction store.
    const assignQ = legacyFetch('/api/admin/workload').then(
      (d) => (d as { assignments?: Assignment[] }).assignments ?? [],
    )

    const [statsRes, mtdRes, assignments] = await Promise.all([statsQ, mtdQ, assignQ])

    const mtd = new Map<string, number>()
    for (const r of mtdRes.rows) mtd.set(r.workspace_id, Number(r.leads))

    const managersByWs = new Map<string, string[]>()
    for (const a of assignments) {
      const list = managersByWs.get(a.client_workspace_id) ?? []
      list.push(a.manager_name)
      managersByWs.set(a.client_workspace_id, list)
    }

    // 4. Assemble inputs and run the projection per client.
    const results: TriageResult[] = statsRes.rows.map((s) => {
      // Data on hand = un-actioned sendable audience. Net out contacts already
      // interested / replied / bounced (not re-sendable) from the total.
      const spoken =
        (s.contacts_interested ?? 0) + (s.contacts_replied ?? 0) + (s.contacts_bounced ?? 0)
      const dataOnHand = Math.max(0, (s.contacts_total ?? 0) - spoken)

      const dailyCapacity = (s.avg_daily_per_mailbox ?? 0) * (s.mailbox_count ?? 0)

      // LPT fallback chain: 30d → 90d → 365d (null when all thin → low-confidence).
      const lpt =
        s.lpt_30d != null
          ? Number(s.lpt_30d)
          : s.lpt_90d != null
            ? Number(s.lpt_90d)
            : s.lpt_365d != null
              ? Number(s.lpt_365d)
              : null

      // Reply rate: current (30d) vs the client's own trailing baseline (90d).
      const replyRateNow = s.reply_rate_30d != null ? Number(s.reply_rate_30d) : null
      const replyRateBaseline = s.reply_rate_90d != null ? Number(s.reply_rate_90d) : null

      const input: TriageInput = {
        workspaceId: s.workspace_id,
        workspaceName: s.workspace_name || s.workspace_id,
        managers: managersByWs.get(s.workspace_id) ?? [],
        target: s.lead_target_monthly ?? 0,
        deliveredMtd: mtd.get(s.workspace_id) ?? 0,
        lpt,
        replyRateNow,
        replyRateBaseline,
        dailyCapacity,
        dataOnHand,
        lastSentAt: s.last_sent_at,
        clientStatus: s.client_status,
        pricePerLead: null, // price lives in legacy clients; wire in for revenue weighting later
        warmupUntil: null, // warmup dates live in portal_clients; wire in a later pass
      }
      return evaluate(input, now)
    })

    // Exclude inactive clients from the actionable list (kept only if they still
    // carry a target, so a paused-but-targeted client isn't silently dropped).
    const active = results.filter(
      (r) => r.clientStatus !== 'inactive' || r.target > 0,
    )

    // Rank worst-first by priority; ties broken by projected shortfall.
    active.sort((a, b) => b.priority - a.priority || b.gap - a.gap)

    // Distinct CM list for the filter dropdown.
    const cmSet = new Set<string>()
    for (const r of active) r.managers.forEach((m) => cmSet.add(m))

    return NextResponse.json({
      generatedAt: now.toISOString(),
      monthStart,
      managers: [...cmSet].sort(),
      clients: active,
    })
  } catch (err) {
    console.error('[triage]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
