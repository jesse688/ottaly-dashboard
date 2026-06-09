import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json() as { password: string }
    const data = await legacyFetch(`/api/admin/managers/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
