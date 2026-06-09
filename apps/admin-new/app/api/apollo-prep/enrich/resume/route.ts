import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function POST() {
  try {
    const res = await fetch(`${LEGACY_API}/api/admin/enrich/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `Legacy API error: ${res.status}` }))
      return NextResponse.json(body, { status: res.status })
    }
    const data: { ok: boolean } = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/resume]', err)
    return NextResponse.json({ error: 'Failed to resume enrichment' }, { status: 502 })
  }
}
