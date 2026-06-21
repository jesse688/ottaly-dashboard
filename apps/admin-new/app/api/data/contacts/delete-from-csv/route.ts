import { type NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Delete contacts whose Email / Apollo Contact Id appears in an uploaded CSV.
// Body is raw CSV text; ?dryRun=1 previews. Stateful destructive op — proxied
// verbatim to legacy /api/contacts/delete-from-csv.
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies()
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
    const body = await req.text()
    const qs = req.nextUrl.search || ''

    const res = await fetch(`${LEGACY_API}/api/contacts/delete-from-csv${qs}`, {
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
    console.error('[data/contacts/delete-from-csv]', err)
    return NextResponse.json({ error: 'Failed to reach legacy server' }, { status: 502 })
  }
}
