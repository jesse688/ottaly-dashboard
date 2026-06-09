import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export interface EnrichStartBody {
  fields: string[]
  limit: number
  concurrency: number
}

export interface EnrichStartResponse {
  ok: boolean
  total: number
}

export async function POST(req: NextRequest) {
  try {
    const body: EnrichStartBody = await req.json()
    const res = await fetch(`${LEGACY_API}/api/admin/enrich/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data: EnrichStartResponse | { error: string } = await res.json()
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/start]', err)
    return NextResponse.json({ error: 'Failed to start enrichment' }, { status: 502 })
  }
}
