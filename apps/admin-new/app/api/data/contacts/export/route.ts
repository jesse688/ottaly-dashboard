import { type NextRequest } from 'next/server'
import { cookies } from 'next/headers'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Apollo CSV export. The legacy route streams a size/count-capped CSV file and
// stamps exported_to_apollo_at as a side effect, so it must run on the legacy
// server. We proxy the raw response (body + the X-* paging headers the UI reads).
export async function GET(req: NextRequest) {
  try {
    const cookieStore = await cookies()
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
    const qs = req.nextUrl.search || ''
    const res = await fetch(`${LEGACY_API}/api/contacts/export${qs}`, {
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    })

    const headers = new Headers()
    for (const h of [
      'content-type',
      'content-disposition',
      'x-total-records',
      'x-has-more',
      'x-next-offset',
      'x-rows-in-file',
    ]) {
      const v = res.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(res.body, { status: res.status, headers })
  } catch (err) {
    console.error('[data/contacts/export]', err)
    return new Response(JSON.stringify({ error: 'Failed to reach legacy server' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
