import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const start = searchParams.get('start') ?? ''
  const end = searchParams.get('end') ?? ''
  const wsIds = searchParams.get('workspace_ids') ?? ''

  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

  try {
    let url = `${LEGACY_API}/api/stats/summary?start=${start}&end=${end}`
    if (wsIds) url += `&workspace_ids=${wsIds}`

    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } })
    const data = await res.json()
    if (!res.ok) return NextResponse.json(data, { status: res.status })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[stats/summary]', err)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 502 })
  }
}
