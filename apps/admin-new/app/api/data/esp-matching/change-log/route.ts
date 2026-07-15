import { NextResponse } from 'next/server'
import { recentChanges } from '@/lib/esp-audit'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const changes = await recentChanges(200)
    return NextResponse.json({ changes })
  } catch (err) {
    // Table may not exist until the first write — return empty rather than 500.
    return NextResponse.json({ changes: [], note: err instanceof Error ? err.message : 'no data' })
  }
}
