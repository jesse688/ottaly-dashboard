import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { workspaceId } = session

  try {
    const [statsRes, campaignRes, leadsRes, repliesRes] = await Promise.all([
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
           COUNT(*) AS total_leads,
           COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS total_meetings
         FROM (
           SELECT DISTINCT ON (lower(email)) status
           FROM esp_leads
           WHERE workspace_id = $1 AND source IN ('plusvibe', 'bison')
             AND status IN ('INTERESTED', 'MEETING_BOOKED')
           ORDER BY lower(email), (source = 'bison') DESC, created_at DESC
         ) d`,
        [workspaceId]
      ),
      // Human replies captured in OUR unibox over the last 30 days — distinct
      // leads who actually replied, EXCLUDING warm-up + OOO/automated. This is our
      // source of truth: a genuine human reply PlusVibe tagged "other" still counts,
      // even if it was never marked a lead.
      pool.query(
        `SELECT COUNT(DISTINCT lower(lead_email)) AS human_replies
           FROM unibox_replies
          WHERE workspace_id = $1
            AND received_at >= CURRENT_DATE - INTERVAL '30 days'
            AND folder NOT IN ('warmup', 'ooo', 'done')
            AND COALESCE(admin_label, category, '') NOT IN ('warmup', 'ooo_auto_reply')`,
        [workspaceId]
      ),
    ])

    const stats = statsRes.rows[0]
    const campaigns = campaignRes.rows[0]
    const leads = leadsRes.rows[0]

    const sent = parseInt(stats.total_sent)
    // Use the GREATER of PlusVibe's count and our unibox human-reply count, so a
    // reply PV didn't record (e.g. tagged "other") still shows in the stats.
    const pvReplied = parseInt(stats.total_replied)
    const uniboxReplied = parseInt(repliesRes.rows[0]?.human_replies ?? '0')
    const replied = Math.max(pvReplied, uniboxReplied)

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
