import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface MailboxAttention {
  type: string
  label: string
  severity: 'warning' | 'critical'
}

export interface Mailbox {
  email: string
  provider: string
  status: string
  warmup_status: string
  workspace_id: string | null
  workspace_name: string | null
  billing_start_date: string | null
  billing_day: number | null
  payload: {
    daily_limit: number
  } | null
  attention: MailboxAttention[] | null
  supplier: string | null
  type: string | null
}

export interface MailboxStat {
  count: number
  sent: number
  replies: number
  bounces: number
}

export interface MailboxesResponse {
  mailboxes: Mailbox[]
  stats: {
    bySupplier: Record<string, MailboxStat>
    byType: Record<string, MailboxStat>
    byClient: Record<string, MailboxStat>
    bySupplierType: Record<string, MailboxStat>
  }
  summary: {
    total: number
    needs_attention: number
  }
  lastRun: string | null
  running: boolean
}

export async function GET() {
  try {
    const data = (await legacyFetch('/api/mailboxes')) as MailboxesResponse
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
