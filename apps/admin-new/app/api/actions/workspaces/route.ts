import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? '6425e882-f33fb46a-2837ff5a-eb535a60'

export interface Workspace {
  id: string
  name: string
  _id?: string
}

export async function GET() {
  try {
    const res = await fetch(`${PV_BASE}/workspaces`, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe error: ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as Workspace[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: 502 })
  }
}
