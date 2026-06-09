import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/revenue/leads')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/revenue-leads]', err)
    return NextResponse.json({ error: 'Failed to fetch revenue leads' }, { status: 502 })
  }
}
