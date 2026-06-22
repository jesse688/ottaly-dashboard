// Full mailbox shape — mirrors the mailbox_full table (admin-legacy parity).
export interface MailboxAuth {
  spf_present: boolean
  spf_strict: boolean
  spf_raw: string | null
  dkim_present: boolean
  dkim_selector: string | null
  dkim_raw: string | null
  dmarc_present: boolean
  dmarc_policy: string | null
  dmarc_raw: string | null
}

export interface AttentionFlag {
  level: 'critical' | 'warning'
  msg: string
}

export interface Mailbox {
  email: string
  account_id: string | null
  domain: string | null
  workspace_id: string | null
  workspace_name: string | null
  status: string | null
  warmup_status: string | null
  provider: string | null
  name: string | null
  daily_limit: number | null
  sending_gap: number | null
  warmup_limit: number | null
  warmup_reply_rate: number | null
  campaigns_count: number
  type: string
  type_auto: string | null
  supplier: string | null
  notes: string | null
  billing_start_date: string | null
  billing_day: number | null
  ignored_at: string | null
  unit_cost: number | null
  attributed_sent: number
  attributed_replies: number
  attributed_bounces: number
  reply_rate: number
  bounce_rate: number
  auth: MailboxAuth | null
  blacklist_count: number
  domain_score: number | null
  domain_notes: string | null
  domain_status: string | null
  attention: AttentionFlag[]
}

// Aggregated group stats (by supplier / by type / by supplier×type).
export interface MailboxGroupStats {
  key: string
  count: number
  active: number
  paused: number
  disconnected: number
  warmup_active: number
  total_daily_limit: number
  avg_daily_limit: number
  total_campaigns: number
  total_sent: number
  total_replies: number
  total_bounces: number
  reply_rate: number
  bounce_rate: number
  auth_clean: number
  blacklist_listed: number
  attention_count: number
  total_monthly_cost: number
  active_pct: number
  warmup_pct: number
  auth_clean_pct: number
  blacklist_listed_pct: number
}

export interface MailboxesResponse {
  mailboxes: Mailbox[]
  summary: { total: number; unassigned_supplier: number; needs_attention: number }
  stats: {
    bySupplier: MailboxGroupStats[]
    byType: MailboxGroupStats[]
    bySupplierType: MailboxGroupStats[]
    byClient: MailboxGroupStats[]
  }
  suppliers: string[]
  types: string[]
  lastRun: string | null
  running: boolean
}
