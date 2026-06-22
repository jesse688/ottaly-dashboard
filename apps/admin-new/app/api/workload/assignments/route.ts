import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// Per-manager assignment data: managers, clients, client↔manager assignments,
// and the default commission rate. Sourced from the legacy SQLite store via the
// admin proxy (the client_managers junction table lives only in legacy).
export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/workload')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[workload/assignments]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load workload assignments' },
      { status: 502 },
    )
  }
}
