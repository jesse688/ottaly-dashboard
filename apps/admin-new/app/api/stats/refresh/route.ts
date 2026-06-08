import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function POST() {
  try {
    const res = await fetch(`${LEGACY_API}/api/stats/refresh`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) return NextResponse.json(data, { status: res.status })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[stats/refresh]', err)
    return NextResponse.json({ error: 'Failed to refresh stats' }, { status: 502 })
  }
}
