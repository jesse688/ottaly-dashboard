import { NextRequest, NextResponse } from 'next/server'
import { warmPerformanceCache } from '@/lib/cache-warming'

export async function POST(req: NextRequest) {
  try {
    await warmPerformanceCache()
    return NextResponse.json({ ok: true, message: 'Cache refresh started' })
  } catch (err) {
    console.error('[stats/refresh]', err)
    return NextResponse.json({ error: 'Failed to refresh cache' }, { status: 500 })
  }
}
