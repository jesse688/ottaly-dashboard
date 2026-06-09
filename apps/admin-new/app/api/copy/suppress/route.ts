import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { workspace_id: string; content_hash: string }
    const data = await legacyFetch('/api/copy/suppress', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as { workspace_id: string; content_hash: string }
    const data = await legacyFetch('/api/copy/suppress', {
      method: 'DELETE',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
