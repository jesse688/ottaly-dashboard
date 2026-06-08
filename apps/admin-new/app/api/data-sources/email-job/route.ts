import { type NextRequest, NextResponse } from 'next/server'

const BASE = ((process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')) + '/email-finder-tool'

// POST — create a new finder job with CSV text
export async function POST(req: NextRequest) {
  const body = await req.json()
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
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const res = await fetch(`${BASE}/api/jobs/${id}`)
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
