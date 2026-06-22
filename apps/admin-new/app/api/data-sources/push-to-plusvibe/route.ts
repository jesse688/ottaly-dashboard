import { type NextRequest, NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

function pvHeaders() {
  return { 'x-api-key': PV_KEY, 'Content-Type': 'application/json' }
}

// GET — fetch workspaces and their campaigns for the picker UI
export async function GET() {
  try {
    const wsRes = await fetch(`${PV_BASE}/workspaces`, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(10000),
    })
    if (!wsRes.ok) return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: wsRes.status })
    const wsData = await wsRes.json()
    const workspaces = (Array.isArray(wsData) ? wsData : wsData.workspaces ?? []) as Record<string, unknown>[]

    // Fetch campaigns for each workspace in parallel
    const withCampaigns = await Promise.all(workspaces.map(async ws => {
      const wsId = (ws.id ?? ws._id) as string
      try {
        const cRes = await fetch(`${PV_BASE}/campaign/list?workspace_id=${wsId}&limit=100`, {
          headers: { 'x-api-key': PV_KEY },
          signal: AbortSignal.timeout(8000),
        })
        const cData = cRes.ok ? await cRes.json() : { data: [] }
        const campaigns = (Array.isArray(cData) ? cData : cData.data ?? cData.campaigns ?? []) as Record<string, unknown>[]
        return {
          id: wsId,
          name: ws.name,
          campaigns: campaigns.map(c => ({ id: (c.id ?? c._id) as string, name: c.name })),
        }
      } catch {
        return { id: wsId, name: ws.name, campaigns: [] }
      }
    }))

    return NextResponse.json({ workspaces: withCampaigns })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

interface PushLead {
  email: string
  first_name: string
  last_name: string
  company_name: string
  company_website: string
  phone_number: string
  city: string
  custom_variables: Record<string, string>
}

// POST — push leads to PlusVibe campaign
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { workspace_id, campaign_id, leads } = body as {
    workspace_id: string
    campaign_id: string
    leads: PushLead[]
  }

  if (!workspace_id || !campaign_id || !leads?.length) {
    return NextResponse.json({ error: 'workspace_id, campaign_id and leads required' }, { status: 400 })
  }

  const BATCH = 100
  let pushed = 0

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH)
    const res = await fetch(`${PV_BASE}/lead/add`, {
      method: 'POST',
      headers: pvHeaders(),
      body: JSON.stringify({ workspace_id, campaign_id, leads: batch }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    if (!res.ok) {
      return NextResponse.json({ error: data.message ?? 'PlusVibe error', pushed }, { status: res.status })
    }
    pushed += batch.length
  }

  return NextResponse.json({ success: true, pushed })
}
