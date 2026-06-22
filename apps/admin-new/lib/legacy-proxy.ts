import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

/**
 * Proxy a request to the legacy Ottaly server, forwarding the caller's method,
 * JSON body and session cookie. Used for stateful endpoints (live CH API director
 * fetch, Reacher email verification, PlusVibe pushes) that are NOT reimplemented
 * DB-direct in admin-new.
 */
export async function proxyToLegacy(
  request: Request,
  legacyPath: string,
  opts: { method?: string } = {}
) {
  try {
    const method = opts.method ?? request.method
    const cookieStore = await cookies()
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')

    let body: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const text = await request.text()
      body = text || undefined
    }

    const res = await fetch(`${LEGACY_API}${legacyPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
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
    console.error('[legacy-proxy]', legacyPath, err)
    return NextResponse.json(
      { error: 'Failed to reach legacy server' },
      { status: 502 }
    )
  }
}
