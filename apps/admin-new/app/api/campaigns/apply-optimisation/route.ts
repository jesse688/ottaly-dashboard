import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await legacyFetch('/api/campaigns/apply-optimisation', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[campaigns/apply-optimisation]', err)
    return NextResponse.json({ error: 'Failed to apply optimisation' }, { status: 502 })
  }
}
