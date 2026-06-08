import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/campaigns/intelligence')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[campaigns/intelligence]', err)
    return NextResponse.json({ error: 'Failed to fetch campaign intelligence' }, { status: 502 })
  }
}
