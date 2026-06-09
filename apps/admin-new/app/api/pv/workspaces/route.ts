import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/pv/workspaces')
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
