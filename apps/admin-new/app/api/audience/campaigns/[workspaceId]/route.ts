import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface CampaignItem {
  campaign_id: string
  campaign_name: string
  event_count: number
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params
  try {
    const data = await legacyFetch(`/api/audience/campaigns/${workspaceId}`)
    return NextResponse.json(data as CampaignItem[])
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
