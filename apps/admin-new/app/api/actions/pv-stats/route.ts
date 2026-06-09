import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? '6425e882-f33fb46a-2837ff5a-eb535a60'

export interface PvEmailStatsRow {
  total_sent_count: number
  total_reply_count: number
  total_ooo_reply_count: number
  total_pos_reply_count: number
  total_bounce_count: number
  total_contacted_count: number
}

export interface PvEmailStatsResponse {
  header?: PvEmailStatsRow
  chart?: PvEmailStatsRow[]
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const workspace_id = searchParams.get('workspace_id')
    const start_date = searchParams.get('start_date')
    const end_date = searchParams.get('end_date')

    if (!workspace_id || !start_date || !end_date) {
      return NextResponse.json({ error: 'Missing required query params' }, { status: 400 })
    }

    const url = `${PV_BASE}/account/email-stats?workspace_id=${workspace_id}&start_date=${start_date}&end_date=${end_date}`
    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe error: ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as PvEmailStatsResponse
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
