import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// Creates a read-only report link for mailbox providers. Admin-only on the
// legacy side — issuing one exposes data outside Ottaly.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const data = await legacyFetch('/api/domains/share', {
      method: 'POST',
      body: JSON.stringify({ client: body?.client ?? null }),
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[domains/share]', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Could not create share link' },
      { status: 500 }
    )
  }
}
