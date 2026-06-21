import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// Per-manager performance for a period: clients, sent, replies, reply rate,
// leads, LTL%, bounced — summed across each manager's assigned workspaces,
// using the same source as the Stats page. Activity windows are clamped to the
// activity-stats epoch (2026-06-19) upstream/here to avoid pre-cutover noise.
const ACTIVITY_EPOCH = '2026-06-19'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rawStart = searchParams.get('start') ?? ''
  const end = searchParams.get('end') ?? ''
  // Clamp activity start to the epoch (leads/revenue handled separately, all-time).
  const start = rawStart && rawStart < ACTIVITY_EPOCH ? ACTIVITY_EPOCH : rawStart

  try {
    const qs = new URLSearchParams()
    if (start) qs.set('start', start)
    if (end) qs.set('end', end)
    const data = await legacyFetch(`/api/admin/workload/cm-stats?${qs.toString()}`)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[workload/cm-stats]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load CM stats' },
      { status: 502 },
    )
  }
}
