import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface SessionResponse {
  ok: boolean
  role: 'admin' | 'manager'
  name: string
  commission_rate?: number
}

export async function GET() {
  try {
    const data: SessionResponse = await legacyFetch('/api/session')
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
}
