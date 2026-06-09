import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/manager/rate')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/manager-rate]', err)
    return NextResponse.json({ error: 'Failed to fetch manager rate' }, { status: 502 })
  }
}
