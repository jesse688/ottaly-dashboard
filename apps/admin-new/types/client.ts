export interface Client {
  id: string
  name: string
  workspace_id: string
  status: 'active' | 'paused' | 'churned' | 'trial'
  vertical: string | null
  monthly_value: number | null
  start_date: string | null
  contact_email: string | null
  notes: string | null
}
