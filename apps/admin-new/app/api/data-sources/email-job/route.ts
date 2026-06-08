import { type NextRequest, NextResponse } from 'next/server'

const BASE = ((process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')) + '/email-finder-tool'

// POST — cancel any stale queued jobs, then create a new finder job
export async function POST(req: NextRequest) {
  const body = await req.json()

  // Cancel any queued jobs from previous runs so they don't block the queue
  try {
    const listRes = await fetch(`${BASE}/api/jobs`)
    if (listRes.ok) {
      const jobs = await listRes.json() as { id: string; status: string }[]
      await Promise.all(
        jobs
          .filter(j => j.status === 'queued')
          .map(j => fetch(`${BASE}/api/jobs/${j.id}/cancel`, { method: 'POST' }))
      )
    }
  } catch { /* non-fatal */ }

  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csvText: body.csvText,
      fileName: body.fileName ?? 'data-sources.csv',
      verify: true,
      verifier: 'reacher',
    }),
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

// GET ?id=xxx — poll job status (fast, no timeout risk)
// GET ?id=xxx&queue=1 — also return queue position
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const [jobRes, listRes] = await Promise.all([
    fetch(`${BASE}/api/jobs/${id}`),
    fetch(`${BASE}/api/jobs`),
  ])

  const data = await jobRes.json()

  // Attach queue position so client can show "2 jobs ahead"
  if (listRes.ok && data.status === 'queued') {
    const jobs = await listRes.json() as { id: string; status: string; createdAt: string }[]
    const queued = jobs
      .filter(j => j.status === 'queued')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const pos = queued.findIndex(j => j.id === id)
    const running = jobs.filter(j => j.status === 'running').length
    data.queuePosition = pos + running // total jobs ahead
  }

  return NextResponse.json(data, { status: jobRes.status })
}
