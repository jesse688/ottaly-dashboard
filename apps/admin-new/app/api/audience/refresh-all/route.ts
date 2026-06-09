import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface RefreshAllClientResult {
  name: string
  workspace_id: string
  error?: string
}

interface RefreshAllResponse {
  ok: boolean
  clients: number
  results: RefreshAllClientResult[]
}

export async function POST() {
  try {
    const data = await legacyFetch('/api/audience/refresh-all', {
      method: 'POST',
    })
    return NextResponse.json(data as RefreshAllResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
