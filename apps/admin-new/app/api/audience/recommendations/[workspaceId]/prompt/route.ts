import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface PromptResponse {
  ok: boolean
  workspace_id: string
  workspace_name: string
  prompt: string
  char_count: number
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params
  try {
    const data = await legacyFetch(`/api/audience/recommendations/${workspaceId}/prompt`)
    return NextResponse.json(data as PromptResponse)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
