import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    const start = request.nextUrl.searchParams.get('start')
    const end = request.nextUrl.searchParams.get('end')
    const workspaceIds = request.nextUrl.searchParams.get('workspace_ids')

    if (!start || !end) {
      return NextResponse.json(
        { error: 'start and end required (YYYY-MM-DD)' },
        { status: 400 }
      )
    }

    const legacyUrl = new URL('http://localhost:3001/api/stats/summary')
    legacyUrl.searchParams.set('start', start)
    legacyUrl.searchParams.set('end', end)
    if (workspaceIds) {
      legacyUrl.searchParams.set('workspace_ids', workspaceIds)
    }

    const response = await fetch(legacyUrl.toString(), {
      headers: {
        'Cookie': request.headers.get('cookie') || '',
      },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch stats from legacy API' },
        { status: response.status }
      )
    }

    const data = await response.json()

    return NextResponse.json(data)
  } catch (err) {
    console.error('[stats/summary]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
