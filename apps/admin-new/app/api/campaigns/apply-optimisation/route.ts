import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const res = await fetch(`${LEGACY_API}/api/campaigns/apply-optimisation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json(data, { status: res.status })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apply-optimisation]', err)
    return NextResponse.json({ error: 'Failed to apply optimisation' }, { status: 502 })
  }
}
