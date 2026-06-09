import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface Manager {
  id: number
  name: string
  commission_rate: number
  base_salary: number
  created_at: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/managers') as Manager[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { name: string; password: string }
    const data = await legacyFetch('/api/admin/managers', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
