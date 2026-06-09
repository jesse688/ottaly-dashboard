import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface PlusVibeWorkspace {
  id: string
  name: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/workspaces') as PlusVibeWorkspace[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
