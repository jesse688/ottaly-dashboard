import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams.toString()
  try {
    const data = await legacyFetch(`/api/stats/summary${params ? `?${params}` : ''}`)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 502 })
  }
}
