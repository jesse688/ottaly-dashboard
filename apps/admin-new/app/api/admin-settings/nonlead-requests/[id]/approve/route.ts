import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const data = await legacyFetch(`/api/admin/nonlead-requests/${id}/approve`, {
      method: 'POST',
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
