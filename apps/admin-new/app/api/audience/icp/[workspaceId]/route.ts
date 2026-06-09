import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface IcpSegmentRow {
  segment: string
  total: number
  replied: number
  leads: number
  not_interested: number
  sent: number
}

interface IcpTotals {
  total: number
  replied: number
  leads: number
  not_interested: number
  sent: number
}

interface IcpResponse {
  workspace_id: string
  totals: IcpTotals
  industry: IcpSegmentRow[]
  size: IcpSegmentRow[]
  city: IcpSegmentRow[]
  county: IcpSegmentRow[]
  seniority: IcpSegmentRow[]
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params
  const campaignId = req.nextUrl.searchParams.get('campaign_id')
  const qs = campaignId ? `?campaign_id=${encodeURIComponent(campaignId)}` : ''
  try {
    const data = await legacyFetch(`/api/audience/icp/${workspaceId}${qs}`)
    return NextResponse.json(data as IcpResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
