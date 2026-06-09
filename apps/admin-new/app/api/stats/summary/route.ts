import { type NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const LEGACY = (process.env.LEGACY_API_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  const workspaceIds = searchParams.get('workspace_ids')

  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

  const jar = await cookies()
  const session = jar.get('ottaly_session')?.value

  const qs = new URLSearchParams({ start, end })
  if (workspaceIds) qs.set('workspace_ids', workspaceIds)

  const upstream = await fetch(`${LEGACY}/api/stats/summary?${qs}`, {
    headers: session ? { Cookie: `ottaly_session=${session}` } : {},
    next: { revalidate: 0 },
  })

  const data: unknown = await upstream.json()
  return NextResponse.json(data, { status: upstream.status })
}
