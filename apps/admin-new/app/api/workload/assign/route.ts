import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// Assign / unassign a campaign manager to a client (the green/red CM toggle).
// Proxies the legacy client_managers junction-table endpoints, which live only
// in the legacy SQLite store. POST = assign, DELETE = unassign.

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const data = await legacyFetch('/api/admin/workload/assign', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[workload/assign POST]', err)
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const data = await legacyFetch('/api/admin/workload/assign', {
      method: 'DELETE',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[workload/assign DELETE]', err)
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
