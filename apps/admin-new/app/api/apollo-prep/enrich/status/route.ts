import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export interface EnrichStatusResponse {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped'
  total?: number
  processed?: number
  updated?: number
  skipped?: number
  failed?: number
  current_domain?: string | null
  log?: string[]
  results?: EnrichResult[]
  total_cost?: number
  domain_ms?: number[]
  pid?: number
}

export interface EnrichResult {
  domain: string
  industry: string | null
  keywords: string | null
  num_employees: number | null
  contacts: number
  status: string
}

export async function GET() {
  try {
    const res = await fetch(`${LEGACY_API}/api/admin/enrich/status`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Legacy API error: ${res.status}` }, { status: 502 })
    }
    const data: EnrichStatusResponse = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/status]', err)
    return NextResponse.json({ error: 'Failed to fetch enrich status' }, { status: 502 })
  }
}
