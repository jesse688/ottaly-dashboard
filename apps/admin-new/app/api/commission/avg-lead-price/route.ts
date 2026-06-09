import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/avg-lead-price')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/avg-lead-price]', err)
    return NextResponse.json({ error: 'Failed to fetch average lead price' }, { status: 502 })
  }
}
