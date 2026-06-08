import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  try {
    const { domain: rawDomain } = await params
    const domain = decodeURIComponent(rawDomain)
    const data = await legacyFetch(`/api/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[domains/delete]', err)
    return NextResponse.json({ error: (err as Error).message || 'Delete failed' }, { status: 500 })
  }
}
