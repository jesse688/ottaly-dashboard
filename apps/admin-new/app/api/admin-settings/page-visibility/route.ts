import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export type PageVisibility = Record<string, boolean>

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/page-visibility') as PageVisibility
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as PageVisibility
    const data = await legacyFetch('/api/admin/page-visibility', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
