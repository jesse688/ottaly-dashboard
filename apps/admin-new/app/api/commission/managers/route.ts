import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/managers')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[commission/managers]', err)
    return NextResponse.json({ error: 'Failed to fetch managers' }, { status: 502 })
  }
}
