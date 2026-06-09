import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface WorkspaceOption {
  id: string
  name: string
}

export interface WorkspacesResponse {
  workspaces: WorkspaceOption[]
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/database/workspaces') as WorkspacesResponse
    return NextResponse.json(data)
  } catch (err) {
    console.error('[database/workspaces]', err)
    return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: 502 })
  }
}
