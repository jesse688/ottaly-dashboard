import { NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export interface SampleCsvSummary {
  contacts: number
  tokens: number
  cost_usd: number
  est_full_db_usd: number
}

export interface SampleCsvFile {
  filename: string
  data: string // base64
}

export interface SampleCsvResponse {
  original: SampleCsvFile
  enriched: SampleCsvFile
  summary: SampleCsvSummary
}

export async function GET() {
  try {
    const res = await fetch(`${LEGACY_API}/api/admin/enrich/sample-csv`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `Legacy API error: ${res.status}` }))
      return NextResponse.json(body, { status: 502 })
    }
    const data: SampleCsvResponse = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[apollo-prep/enrich/sample-csv]', err)
    return NextResponse.json({ error: 'Failed to generate sample CSV' }, { status: 502 })
  }
}
