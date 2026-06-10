import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspace_id')
  try {
    const data = await legacyFetch(
      `/api/copy/diagnostic${workspaceId ? `?workspace_id=${workspaceId}` : ''}`
    )
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
