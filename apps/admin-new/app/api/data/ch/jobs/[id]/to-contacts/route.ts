import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Push a finished job's scraped contacts into the `contacts` table so they flow
// into the Contacts → verify → push-to-PlusVibe pipeline. This is part of the
// stateful contacts pipeline, so proxy to the legacy server which owns it.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  try {
    const res = await fetch(`${LEGACY_API}/api/ch/jobs/${id}/to-contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: req.headers.get('cookie') ?? '',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json(data, { status: res.status })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[ch-job-to-contacts]', err)
    return NextResponse.json(
      { error: 'Failed to send to contacts' },
      { status: 502 }
    )
  }
}
