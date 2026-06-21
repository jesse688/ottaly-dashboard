import { type NextRequest, NextResponse } from 'next/server'

// AI Enrichment is a stateful, long-running job that runs IN the legacy server
// process (Gemini/Claude domain enrichment + globally-throttled Companies House
// lookups, with pause/resume/stop and live progress). It is NOT reimplemented
// here — every call is forwarded to the legacy server, mirroring the legacy
// /api/admin/enrich/* path family:
//   GET  scan?fields=&mode=     POST start     GET  status
//   POST pause   POST resume    POST stop      GET  sample-csv
const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

async function proxy(req: NextRequest, action: string[]) {
  const path = `/api/admin/enrich/${action.join('/')}`
  const qs = req.nextUrl.search // includes leading '?' if present
  const url = `${LEGACY_API}${path}${qs}`

  const init: RequestInit = {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      // Forward auth cookies so the legacy session middleware accepts the call.
      cookie: req.headers.get('cookie') ?? '',
    },
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await req.text()
    if (body) init.body = body
  }

  try {
    const res = await fetch(url, init)
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (err) {
    console.error('[apollo-prep/enrich proxy]', path, err)
    return NextResponse.json({ error: 'Legacy server unavailable' }, { status: 502 })
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ action: string[] }> }
) {
  const { action } = await params
  return proxy(req, action)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string[] }> }
) {
  const { action } = await params
  return proxy(req, action)
}
