import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await legacyFetch('/api/domains/check', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[domains/check]', err)
    return NextResponse.json({ error: (err as Error).message || 'Check failed' }, { status: 500 })
  }
}
