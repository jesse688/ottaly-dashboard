import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface AdminClient {
  id: number
  username: string
  workspace_id: string
  workspace_name: string
  plan_leads: number
  price_per_lead: number
  stripe_customer_id: string | null
  contact_name: string
  contact_email: string
  contact_phone: string
  website: string
  notes: string
  client_status: string
  restart_date: string | null
  campaign_manager: string
  campaign_manager_2: string
  commission_rate: number
  manager_start_date: string | null
  lead_target_monthly: number
  created_at: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/clients') as AdminClient[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      username: string
      password: string
      workspace_id: string
      workspace_name: string
      plan_leads: number
      price_per_lead: number
    }
    const data = await legacyFetch('/api/admin/clients', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
