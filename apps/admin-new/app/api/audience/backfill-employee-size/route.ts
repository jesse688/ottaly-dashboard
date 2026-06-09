import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface BackfillEmpSizeClientResult {
  name: string
  fromRaw: number
  fromPV: number
  fromDomain: number
}

interface BackfillEmpSizeResponse {
  ok: boolean
  totalUpdated: number
  results: BackfillEmpSizeClientResult[]
}

export async function POST() {
  try {
    const data = await legacyFetch('/api/audience/backfill-employee-size', {
      method: 'POST',
    })
    return NextResponse.json(data as BackfillEmpSizeResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
