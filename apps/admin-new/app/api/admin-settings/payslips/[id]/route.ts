import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const data = await legacyFetch(`/api/admin/payslips/${id}`, {
      method: 'DELETE',
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
