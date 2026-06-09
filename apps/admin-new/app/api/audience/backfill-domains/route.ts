import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface BackfillTotals {
  industry?: number
  city?: number
  state?: number
  country?: number
  num_employees?: number
}

interface BackfillClientResult {
  name: string
  workspace_id: string
  totals?: BackfillTotals
}

interface BackfillSingleResponse {
  ok: boolean
  workspace_id: string
  totals?: BackfillTotals
}

interface BackfillAllResponse {
  ok: boolean
  clients: number
  results: BackfillClientResult[]
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { workspace_id?: string }
    const data = await legacyFetch('/api/audience/backfill-domains', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data as BackfillSingleResponse | BackfillAllResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
