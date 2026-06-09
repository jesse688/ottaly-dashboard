import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface Split80Winner {
  campaign_name: string
  reason: string
}

interface Split20Test {
  angle: string
  subject_lines?: string[]
  opening_lines?: string[]
}

interface Recommendation {
  title: string
  confidence: 'high' | 'medium' | 'low'
  target: string
  rationale: string
  split_80_winner?: Split80Winner
  split_20_test?: Split20Test
  data_gaps?: string
}

interface RecommendationsResponse {
  summary?: string
  recommendations: Recommendation[]
  generated_at?: string
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params
  try {
    const data = await legacyFetch(`/api/audience/recommendations/${workspaceId}`)
    return NextResponse.json(data as RecommendationsResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
