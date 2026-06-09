import { type NextRequest, NextResponse } from 'next/server'

const LEGACY = (process.env.LEGACY_API_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  const workspaceIds = searchParams.get('workspace_ids')

  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

  const qs = new URLSearchParams({ start, end })
  if (workspaceIds) qs.set('workspace_ids', workspaceIds)

  try {
    const upstream = await fetch(`${LEGACY}/api/stats/summary?${qs}`, {
      credentials: 'include',
      headers: {
        Cookie: req.headers.get('cookie') || '',
      },
      next: { revalidate: 0 },
    })

    const data: unknown = await upstream.json()
    return NextResponse.json(data, { status: upstream.status })
  } catch (err) {
    console.error('[stats/summary]', err)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
