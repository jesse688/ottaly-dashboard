export interface Campaign {
  id: string
  name: string
  workspace_id: string
  workspace_name?: string
  status: string
  campaign_type: string
  lead_count: number
  sent_count: number
  replied_count: number
  bounced_count: number
  positive_reply_count: number
  reply_rate: number
  reply_rate_calc: number
  bounce_rate: number
  positive_rate: number
  lead_rate: number
  daily_limit: number | null
  last_lead_sent: string | null
  last_lead_replied: string | null
  created_at: string
  updated_at: string
}
