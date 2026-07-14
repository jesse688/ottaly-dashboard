import { type NextRequest, NextResponse } from 'next/server'

// ESP Matching (Advanced ESP Matching / deliverability) read + write.
// These live ONLY on PlusVibe's internal API (api.pipl.ai/v1) — the public
// x-api-key API 404s for them (verified). So this route proxies to pipl.ai
// using a short-lived Bearer JWT the caller supplies (Authorization header),
// exactly like the standalone esp-matching tool. The browser can't call
// pipl.ai directly (CORS), so it goes through this same-origin proxy.
//
// GET  /api/data/esp-matching/setting?workspace_id=...   → current mapping
// PUT  /api/data/esp-matching/setting?workspace_id=...   → save mapping (body = payload)

const PIPL_BASE = 'https://api.pipl.ai/v1'

function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth
}

export async function GET(req: NextRequest) {
  const token = bearer(req)
  const workspaceId = req.nextUrl.searchParams.get('workspace_id') || ''
  if (!token) return NextResponse.json({ error: 'Missing Bearer token' }, { status: 400 })
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
  try {
    const res = await fetch(
      `${PIPL_BASE}/user/get-workspace-setting?workspace_id=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
    )
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'proxy error' },
      { status: 502 },
    )
  }
}

export async function PUT(req: NextRequest) {
  const token = bearer(req)
  const workspaceId = req.nextUrl.searchParams.get('workspace_id') || ''
  if (!token) return NextResponse.json({ error: 'Missing Bearer token' }, { status: 400 })
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Missing/invalid JSON body' }, { status: 400 })
  try {
    const res = await fetch(
      `${PIPL_BASE}/user/update-workspace-setting?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    )
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'proxy error' },
      { status: 502 },
    )
  }
}
