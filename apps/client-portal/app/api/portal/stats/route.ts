import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { workspaceId } = session

  try {
    const [statsRes, campaignRes, leadsRes] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM((data->>'sent_count')::int), 0)          AS total_sent,
           COALESCE(SUM((data->>'replied_count')::int), 0)       AS total_replied,
           COALESCE(SUM((data->>'positive_reply_count')::int), 0) AS total_leads,
           COALESCE(SUM((data->>'bounced_count')::int), 0)       AS total_bounced
         FROM perf_cache_daily
         WHERE ws_id = $1
           AND date >= CURRENT_DATE - INTERVAL '30 days'`,
        [workspaceId]
      ),
      pool.query(
        `SELECT COUNT(*) AS total_campaigns,
                COUNT(*) FILTER (WHERE status = 'active') AS active_campaigns
         FROM esp_campaigns
         WHERE workspace_id = $1 AND source = 'plusvibe'`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('INTERESTED', 'MEETING_BOOKED')) AS total_leads,
           COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS total_meetings
         FROM esp_leads
         WHERE workspace_id = $1 AND source = 'plusvibe'`,
        [workspaceId]
      ),
    ])

    const stats = statsRes.rows[0]
    const campaigns = campaignRes.rows[0]
    const leads = leadsRes.rows[0]

    const sent = parseInt(stats.total_sent)
    const replied = parseInt(stats.total_replied)

    return NextResponse.json({
      sent,
      replied,
      replyRate: sent > 0 ? replied / sent : 0,
      leads: parseInt(leads.total_leads),
      meetings: parseInt(leads.total_meetings),
      bounced: parseInt(stats.total_bounced),
      bounceRate: sent > 0 ? parseInt(stats.total_bounced) / sent : 0,
      totalCampaigns: parseInt(campaigns.total_campaigns),
      activeCampaigns: parseInt(campaigns.active_campaigns),
    })
  } catch (err) {
    console.error('[portal/stats]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
