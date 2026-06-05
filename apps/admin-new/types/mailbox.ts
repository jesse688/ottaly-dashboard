export interface Mailbox {
  id: string
  email: string
  status: 'active' | 'disconnected' | 'warming' | 'paused' | 'error'
  warmup_enabled: boolean
  warmup_score: number | null
  supplier: string | null
  workspace_id: string | null
  workspace_name: string | null
  daily_limit: number | null
  sent_today: number | null
  tags: string[]
  billing_client: string | null
  last_checked: string | null
}
