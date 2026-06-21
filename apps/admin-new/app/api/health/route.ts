import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// One client card = latest snapshot + its open actions + its open copy alerts.
// Mirrors admin-legacy /api/health/clients + /api/health/copy-alerts, merged
// into a single payload so the page makes one round-trip.

interface SnapshotRow {
  workspace_id: string
  workspace_name: string | null
  snapshot_date: string
  health_score: number | null
  health_band: string | null
  sent_7d: number | null
  sent_30d: number | null
  replies_7d: number | null
  replies_30d: number | null
  bounces_7d: number | null
  leads_7d: number | null
  leads_30d: number | null
  reply_rate_7d: string | null
  reply_rate_30d: string | null
  reply_rate_baseline: string | null
  bounce_rate_7d: string | null
  reply_rate_gmail_7d: string | null
  reply_rate_outlook_7d: string | null
  mailbox_total: number | null
  mailbox_unhealthy: number | null
  domain_unhealthy: number | null
  lead_target_monthly: number | null
  leads_mtd: number | null
  leads_expected_mtd: string | null
  pace_pct: string | null
  ai_briefing: string | null
  ai_briefing_source: string | null
}

interface ActionRow {
  id: string
  workspace_id: string
  label: string
  kind: string | null
  rationale: string | null
  priority: number | null
  target_metric: string | null
  target_direction: string | null
  completed_at: string | null
  completed_by: string | null
  outcome: string | null
  outcome_notes: string | null
}

interface AlertRow {
  id: string
  workspace_id: string
  campaign_name: string | null
  step: number | null
  variant: string | null
  alert_type: string | null
  severity: string | null
  reply_rate_baseline: string | null
  reply_rate_current: string | null
  lifetime_sends: number | null
  template_subject: string | null
}

const n = (v: string | number | null): number | null =>
  v == null ? null : typeof v === 'number' ? v : Number(v)

export async function GET() {
  try {
    const snapRes = await pool.query<SnapshotRow>(`
      SELECT DISTINCT ON (h.workspace_id)
             h.workspace_id,
             ws.workspace_name,
             h.snapshot_date::text AS snapshot_date,
             h.health_score, h.health_band,
             h.sent_7d, h.sent_30d,
             h.replies_7d, h.replies_30d,
             h.bounces_7d, h.leads_7d, h.leads_30d,
             h.reply_rate_7d, h.reply_rate_30d, h.reply_rate_baseline,
             h.bounce_rate_7d, h.reply_rate_gmail_7d, h.reply_rate_outlook_7d,
             h.mailbox_total, h.mailbox_unhealthy, h.domain_unhealthy,
             h.lead_target_monthly, h.leads_mtd,
             h.leads_expected_mtd, h.pace_pct,
             h.ai_briefing, h.ai_briefing_source
        FROM client_health_snapshots h
        LEFT JOIN workspace_stats ws ON ws.workspace_id = h.workspace_id
       ORDER BY h.workspace_id, h.snapshot_date DESC
    `)

    const actsRes = await pool.query<ActionRow>(`
      SELECT a.id::text, a.workspace_id, a.label, a.kind, a.rationale,
             a.priority, a.target_metric, a.target_direction,
             a.completed_at::text AS completed_at, a.completed_by,
             a.outcome, a.outcome_notes
        FROM health_actions a
       WHERE a.dismissed_at IS NULL
         AND a.snapshot_date = (
           SELECT MAX(snapshot_date) FROM health_actions a2
            WHERE a2.workspace_id = a.workspace_id
         )
       ORDER BY a.priority ASC NULLS LAST, a.id ASC
    `)

    const alertsRes = await pool.query<AlertRow>(`
      SELECT ta.id::text, ta.workspace_id, ta.campaign_name, ta.step, ta.variant,
             ta.alert_type, ta.severity, ta.reply_rate_baseline, ta.reply_rate_current,
             ta.lifetime_sends, t.subject AS template_subject
        FROM template_alerts ta
        LEFT JOIN templates t ON t.content_hash = ta.content_hash
       WHERE ta.dismissed_at IS NULL
         AND ta.resolved_at IS NULL
       ORDER BY CASE ta.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                ta.created_at DESC
       LIMIT 200
    `)

    const actionsByWs = new Map<string, ActionRow[]>()
    for (const a of actsRes.rows) {
      const list = actionsByWs.get(a.workspace_id) ?? []
      list.push(a)
      actionsByWs.set(a.workspace_id, list)
    }
    const alertsByWs = new Map<string, AlertRow[]>()
    for (const a of alertsRes.rows) {
      const list = alertsByWs.get(a.workspace_id) ?? []
      list.push(a)
      alertsByWs.set(a.workspace_id, list)
    }

    const clients = snapRes.rows.map((s) => ({
      workspace_id: s.workspace_id,
      workspace_name: s.workspace_name ?? s.workspace_id,
      snapshot_date: s.snapshot_date,
      health_score: s.health_score,
      health_band: s.health_band,
      sent_7d: s.sent_7d,
      sent_30d: s.sent_30d,
      replies_7d: s.replies_7d,
      replies_30d: s.replies_30d,
      bounces_7d: s.bounces_7d,
      leads_7d: s.leads_7d,
      leads_30d: s.leads_30d,
      reply_rate_7d: n(s.reply_rate_7d),
      reply_rate_30d: n(s.reply_rate_30d),
      reply_rate_baseline: n(s.reply_rate_baseline),
      bounce_rate_7d: n(s.bounce_rate_7d),
      reply_rate_gmail_7d: n(s.reply_rate_gmail_7d),
      reply_rate_outlook_7d: n(s.reply_rate_outlook_7d),
      mailbox_total: s.mailbox_total,
      mailbox_unhealthy: s.mailbox_unhealthy,
      domain_unhealthy: s.domain_unhealthy,
      lead_target_monthly: s.lead_target_monthly,
      leads_mtd: s.leads_mtd,
      leads_expected_mtd: n(s.leads_expected_mtd),
      pace_pct: n(s.pace_pct),
      ai_briefing: s.ai_briefing,
      ai_briefing_source: s.ai_briefing_source,
      actions: actionsByWs.get(s.workspace_id) ?? [],
      copy_alerts: (alertsByWs.get(s.workspace_id) ?? []).map((a) => ({
        ...a,
        reply_rate_baseline: n(a.reply_rate_baseline),
        reply_rate_current: n(a.reply_rate_current),
      })),
    }))

    const generated_at = snapRes.rows.reduce<string | null>(
      (max, r) => (max == null || r.snapshot_date > max ? r.snapshot_date : max),
      null,
    )

    return NextResponse.json({ clients, generated_at })
  } catch (err) {
    console.error('[health]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
