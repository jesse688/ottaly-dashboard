import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface NonleadRequest {
  id: number
  lead_id: number
  client_id: number
  username: string
  workspace_name: string
  reason: string
  created_at: string
  lead_name: string
  lead_email: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/nonlead-requests') as NonleadRequest[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
