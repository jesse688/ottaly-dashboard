import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/workspace-prices')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/workspace-prices]', err)
    return NextResponse.json({ error: 'Failed to fetch workspace prices' }, { status: 502 })
  }
}
