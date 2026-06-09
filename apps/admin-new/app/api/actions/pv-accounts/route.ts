import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? '6425e882-f33fb46a-2837ff5a-eb535a60'

export interface PvAccount {
  _id: string
  email: string
  status: string
  warmup_status: string
  provider: string
  payload: {
    daily_limit: number
  } | null
}

export interface PvAccountsResponse {
  accounts?: PvAccount[]
  data?: PvAccount[]
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const workspace_id = searchParams.get('workspace_id')

    if (!workspace_id) {
      return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
    }

    const url = `${PV_BASE}/account/list?workspace_id=${workspace_id}&skip=0&limit=500`
    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe error: ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as PvAccountsResponse | PvAccount[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
