import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function POST() {
  try {
    const res = await fetch(`${LEGACY_API}/api/admin/enrich/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Legacy API error: ${res.status}` }, { status: 502 })
    }
    const data: { ok: boolean } = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/pause]', err)
    return NextResponse.json({ error: 'Failed to pause enrichment' }, { status: 502 })
  }
}
