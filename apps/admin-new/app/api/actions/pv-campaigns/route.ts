import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

export interface PvCampaignStat {
  camp_id: string
  camp_name: string
  status: string
  sent_count: number
  replied_count: number
  ooo_reply_count: number
  positive_reply_count: number
  bounced_count: number
  lead_contacted_count: number
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

    const url = `${PV_BASE}/analytics/campaign/stats?workspace_id=${workspace_id}&start_date=${start_date}&end_date=${end_date}`
    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe error: ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as PvCampaignStat[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
