import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Cancel a queued/running scrape job. Coordinates with the scraper-service
// worker, so proxy to the legacy server which owns that logic.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const res = await fetch(`${LEGACY_API}/api/ch/jobs/${id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: req.headers.get('cookie') ?? '',
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json(data, { status: res.status })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[ch-job-cancel]', err)
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 502 })
  }
}
