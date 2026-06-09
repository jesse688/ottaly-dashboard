import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface DefaultCommission {
  rate: number
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/default-commission') as DefaultCommission
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { rate: number }
    const data = await legacyFetch('/api/admin/default-commission', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
