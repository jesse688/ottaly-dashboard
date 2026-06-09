import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/gbp-zar-rate')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/gbp-zar-rate]', err)
    return NextResponse.json({ error: 'Failed to fetch GBP/ZAR rate' }, { status: 502 })
  }
}
