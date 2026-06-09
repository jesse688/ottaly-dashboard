import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export interface EnrichScanResponse {
  domains: number
  contacts: number
  cost_usd: number
}

export async function GET(req: NextRequest) {
  try {
    const fields = req.nextUrl.searchParams.get('fields') ?? 'keywords,industry,num_employees'
    const res = await fetch(
      `${LEGACY_API}/api/admin/enrich/scan?fields=${encodeURIComponent(fields)}`,
      { headers: { 'Content-Type': 'application/json' } },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Scan failed' }))
      return NextResponse.json(body, { status: 502 })
    }
    const data: EnrichScanResponse = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/scan]', err)
    return NextResponse.json({ error: 'Failed to scan database' }, { status: 502 })
  }
}
