import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET(_req: NextRequest) {
  try {
    const data = await legacyFetch('/api/domains/health')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[domains/health]', err)
    return NextResponse.json({ error: 'Failed to fetch domain health', rows: [], lastRun: null }, { status: 500 })
  }
}
