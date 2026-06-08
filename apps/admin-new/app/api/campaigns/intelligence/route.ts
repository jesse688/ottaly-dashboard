import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Performance tier thresholds — match legacy scoreCampaign()
function scoreCampaign(
  sentCount: number,
  repliedCount: number,
  bouncedCount: number,
  positiveReplyCount: number,
  leadCount: number,
  wsAvgReplyRate: number,
) {
  if (sentCount < 50) {
    return { tier: 'new', replyRate: 0, posReplyRate: 0, exhaustion: 0, flags: [] }
  }
  const replyRate    = sentCount > 0 ? repliedCount / sentCount : 0
  const posReplyRate = repliedCount > 0 ? positiveReplyCount / repliedCount : 0
  // Use sent_count as proxy for contacted since we don't store lead_contacted_count
  const exhaustion   = leadCount > 0 ? Math.min(sentCount / leadCount, 1) : 0

  const flags: { type: string; msg: string }[] = []

  if (replyRate < 0.005 && sentCount > 300)
    flags.push({ type: 'critical', msg: 'Very low reply rate — copy likely needs refreshing' })
  else if (replyRate < 0.01 && sentCount > 200)
    flags.push({ type: 'warning', msg: 'Below average reply rate' })

  if (wsAvgReplyRate > 0 && replyRate > wsAvgReplyRate * 1.5)
    flags.push({ type: 'top', msg: 'Top performer — 50%+ above workspace average' })

  if (posReplyRate > 0.4 && repliedCount > 5)
    flags.push({ type: 'positive', msg: 'High quality — strong positive reply ratio' })

  if (bouncedCount > 0 && sentCount > 0 && bouncedCount / sentCount > 0.05)
    flags.push({ type: 'critical', msg: 'High bounce rate — check email list quality' })

  if (exhaustion >= 0.9)
    flags.push({ type: 'critical', msg: `Data exhausted — ${Math.round(exhaustion * 100)}% of leads contacted, needs fresh data` })
  else if (exhaustion >= 0.75)
    flags.push({ type: 'warning', msg: `Data running low — ${Math.round(exhaustion * 100)}% of leads contacted` })

  const tier =
    replyRate >= 0.025 ? 'top' :
    replyRate >= 0.01  ? 'good' :
    replyRate >= 0.005 ? 'warning' : 'critical'

  return { tier, replyRate, posReplyRate, exhaustion, flags }
}

export interface CampaignRow {
  id: string
  name: string
  status: string
  sent_count: number
  replied_count: number
  bounced_count: number
  positive_reply_count: number
  lead_count: number
  last_lead_sent: string | null
  last_lead_replied: string | null
  workspace_id: string
  workspace_name: string
}

export interface ScoredCampaign {
  id: string
  name: string
  status: string
  sent: number
  replies: number
  bounces: number
  posReplies: number
  leads: number
  replyRate: number
  posReplyRate: number
  exhaustion: number
  tier: string
  flags: { type: string; msg: string }[]
  lastSent: string | null
  lastReplied: string | null
}

export interface WorkspaceGroup {
  id: string
  name: string
  campaigns: ScoredCampaign[]
  avgReplyRate: number
  totalSent: number
  totalReplies: number
  activeCampaigns: number
}

export interface IntelligenceResponse {
  workspaces: WorkspaceGroup[]
  updatedAt: string
}

export async function GET() {
  try {
    const res = await pool.query<CampaignRow>(
      `SELECT
         c.id, c.name, c.status,
         COALESCE(c.sent_count, 0)            AS sent_count,
         COALESCE(c.replied_count, 0)         AS replied_count,
         COALESCE(c.bounced_count, 0)         AS bounced_count,
         COALESCE(c.positive_reply_count, 0)  AS positive_reply_count,
         COALESCE(c.lead_count, 0)            AS lead_count,
         c.last_lead_sent, c.last_lead_replied,
         c.workspace_id,
         COALESCE(w.name, c.workspace_id)     AS workspace_name
       FROM esp_campaigns c
       LEFT JOIN esp_workspaces w
         ON w.id = c.workspace_id AND w.source = c.source
       WHERE c.source = 'plusvibe'
       ORDER BY w.name, c.last_lead_sent DESC NULLS LAST, c.created_at DESC`
    )

    // Group by workspace
    const wsMap = new Map<string, { id: string; name: string; rows: CampaignRow[] }>()
    for (const row of res.rows) {
      const key = row.workspace_id
      if (!wsMap.has(key)) {
        wsMap.set(key, { id: row.workspace_id, name: row.workspace_name, rows: [] })
      }
      wsMap.get(key)!.rows.push(row)
    }

    const workspaces: WorkspaceGroup[] = []

    for (const ws of wsMap.values()) {
      // Compute workspace avg reply rate from campaigns with ≥50 sends
      const withData = ws.rows.filter(c => c.sent_count >= 50)
      const wsAvgReplyRate = withData.length
        ? withData.reduce((s, c) =>
            s + (c.sent_count > 0 ? c.replied_count / c.sent_count : 0), 0
          ) / withData.length
        : 0

      const scored: ScoredCampaign[] = ws.rows.map(c => {
        const metrics = scoreCampaign(
          c.sent_count, c.replied_count, c.bounced_count,
          c.positive_reply_count, c.lead_count, wsAvgReplyRate,
        )
        return {
          id:           c.id,
          name:         c.name,
          status:       c.status || 'UNKNOWN',
          sent:         c.sent_count,
          replies:      c.replied_count,
          bounces:      c.bounced_count,
          posReplies:   c.positive_reply_count,
          leads:        c.lead_count,
          replyRate:    metrics.replyRate,
          posReplyRate: metrics.posReplyRate,
          exhaustion:   metrics.exhaustion,
          tier:         metrics.tier,
          flags:        metrics.flags,
          lastSent:     c.last_lead_sent,
          lastReplied:  c.last_lead_replied,
        }
      })

      // Sort by reply rate desc (matches legacy)
      scored.sort((a, b) => b.replyRate - a.replyRate)

      workspaces.push({
        id:              ws.id,
        name:            ws.name,
        campaigns:       scored,
        avgReplyRate:    wsAvgReplyRate,
        totalSent:       scored.reduce((s, c) => s + c.sent, 0),
        totalReplies:    scored.reduce((s, c) => s + c.replies, 0),
        activeCampaigns: scored.filter(c => c.status === 'ACTIVE').length,
      })
    }

    // Sort workspaces by name
    workspaces.sort((a, b) => a.name.localeCompare(b.name))

    const response: IntelligenceResponse = {
      workspaces,
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[campaigns/intelligence]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
