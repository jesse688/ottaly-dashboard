import { type NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Chunked CSV import. Body is raw CSV text (text/csv), not JSON, so we proxy the
// raw body + query string straight through to legacy /api/import/csv rather than
// using the JSON proxy helper. Stateful (in-memory import jobs) — not reimplemented.
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies()
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
    const body = await req.text()
    const qs = req.nextUrl.search || ''

    const res = await fetch(`${LEGACY_API}/api/import/csv${qs}`, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers.get('content-type') || 'text/csv',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body,
    })
    const text = await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { error: text || 'Legacy returned non-JSON response' }
    }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[data/contacts/import/csv]', err)
    return NextResponse.json({ error: 'Failed to reach legacy server' }, { status: 502 })
  }
}

// Import job polling — proxied to legacy.
export async function GET(req: NextRequest) {
  try {
    const cookieStore = await cookies()
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
    const qs = req.nextUrl.search || ''
    const res = await fetch(`${LEGACY_API}/api/import/jobs${qs}`, {
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ jobs: [] })
  }
}
