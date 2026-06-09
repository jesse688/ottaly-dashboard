import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? '6425e882-f33fb46a-2837ff5a-eb535a60'

export interface PvWarmupEmailAcc {
  inbox_percent: string
  spam_percent: string
  promotion_percent: string
  google_percent: string
  microsoft_percent: string
  total_warmup_sent: number
  total_inboxes: number
  total_domains: number
  email_domain_detail: Record<string, number>
}

export interface PvWarmupResponse {
  emailAcc?: PvWarmupEmailAcc
  data?: PvWarmupEmailAcc
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

    const url = `${PV_BASE}/account/warmup-stats?workspace_id=${workspace_id}&start_date=${start_date}&end_date=${end_date}`
    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe error: ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as PvWarmupResponse
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
