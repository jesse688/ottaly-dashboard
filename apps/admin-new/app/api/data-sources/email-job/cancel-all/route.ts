import { NextResponse } from 'next/server'

const BASE = ((process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')) + '/email-finder-tool'

export async function POST() {
  try {
    const listRes = await fetch(`${BASE}/api/jobs`)
    if (!listRes.ok) return NextResponse.json({ error: 'Failed to list jobs' }, { status: 500 })

    const jobs = await listRes.json() as { id: string; status: string }[]
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'waiting')

    await Promise.all(active.map(j => fetch(`${BASE}/api/jobs/${j.id}/cancel`, { method: 'POST' })))

    return NextResponse.json({ cancelled: active.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
