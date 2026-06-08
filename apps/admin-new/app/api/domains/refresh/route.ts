import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function POST(req: NextRequest) {
  try {
    const data = await legacyFetch('/api/domains/refresh', {
      method: 'POST',
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[domains/refresh]', err)
    return NextResponse.json({ error: (err as Error).message || 'Refresh failed' }, { status: 500 })
  }
}
