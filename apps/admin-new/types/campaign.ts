export interface Campaign {
  id: string
  name: string
  workspace_id: string
  workspace_name?: string
  status: 'active' | 'paused' | 'draft' | 'completed'
  sent: number
  opens: number
  replies: number
  bounces: number
  open_rate: number
  reply_rate: number
  bounce_rate: number
  created_at: string
  updated_at: string
}
