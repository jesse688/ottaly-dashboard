import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface ClientStatusRow {
  workspace_id: string
  workspace_name: string
  client_status: 'active' | 'inactive'
  restart_date: string | null
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/client-status') as ClientStatusRow[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch client status' }, { status: 502 })
  }
}
