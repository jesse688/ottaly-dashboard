import { type NextRequest, NextResponse } from 'next/server'
import { getPvJwt, invalidatePvJwt, hasPvCreds } from '@/lib/pv-auth'
import { normalizeMapping, logEspChange, type Mapping } from '@/lib/esp-audit'

// ESP Matching (Advanced ESP Matching / deliverability) read + write.
// These live ONLY on PlusVibe's internal API (api.pipl.ai/v1) — the public
// x-api-key API 404s for them. Auth is a Bearer JWT: the server logs in with
// stored creds (PLUSVIBE_LOGIN_EMAIL/PASSWORD) via lib/pv-auth so no human needs
// to paste a token. A caller MAY still pass Authorization: Bearer <jwt> to
// override (e.g. a different account); that takes precedence.
//
// GET  /api/data/esp-matching/setting?workspace_id=...
// PUT  /api/data/esp-matching/setting?workspace_id=...   (body = payload)

const PIPL_BASE = 'https://api.pipl.ai/v1'

function suppliedBearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

// Resolve the token to use: explicit Bearer wins, else server auto-login.
async function resolveToken(req: NextRequest): Promise<string> {
  const supplied = suppliedBearer(req)
  if (supplied) return supplied
  if (hasPvCreds()) return getPvJwt()
  throw new Error('No token: pass Authorization: Bearer, or set PLUSVIBE_LOGIN_* env')
}

// Call pipl.ai; if it 401s AND we're using the server token, refresh once.
async function piplFetch(
  path: string,
  init: RequestInit,
  usingServerToken: boolean,
  setAuth: (t: string) => void,
): Promise<Response> {
  let res = await fetch(`${PIPL_BASE}${path}`, init)
  if (res.status === 401 && usingServerToken) {
    invalidatePvJwt()
    const fresh = await getPvJwt()
    setAuth(fresh)
    res = await fetch(`${PIPL_BASE}${path}`, init)
  }
  return res
}

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspace_id') || ''
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
  try {
    const usingServer = !suppliedBearer(req)
    let token = await resolveToken(req)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    const res = await piplFetch(
      `/user/get-workspace-setting?workspace_id=${encodeURIComponent(workspaceId)}`,
      { headers, signal: AbortSignal.timeout(15000) },
      usingServer,
      (t) => {
        token = t
        headers.Authorization = `Bearer ${t}`
      },
    )
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'proxy error' }, { status: 502 })
  }
}

export async function PUT(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspace_id') || ''
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Missing/invalid JSON body' }, { status: 400 })
  const wsName = req.nextUrl.searchParams.get('ws_name')
  const source = req.nextUrl.searchParams.get('source') || 'manual'
  try {
    const usingServer = !suppliedBearer(req)
    const token = await resolveToken(req)
    const authHeader = { Authorization: `Bearer ${token}` }

    // Capture BEFORE mapping for the audit log (best-effort; don't block write).
    let before: Mapping | null = null
    try {
      const bres = await fetch(
        `${PIPL_BASE}/user/get-workspace-setting?workspace_id=${encodeURIComponent(workspaceId)}`,
        { headers: authHeader, signal: AbortSignal.timeout(15000) },
      )
      if (bres.ok) {
        const bd = await bres.json()
        const esp = bd?.esp_setting ? bd : bd?.data?.esp_setting ? bd.data : bd?.data || bd
        before = normalizeMapping(esp?.esp_setting)
      }
    } catch {
      /* before-read failed; proceed with the write, log after-only */
    }

    const init: RequestInit = {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }
    const res = await piplFetch(
      `/user/update-workspace-setting?workspace_id=${encodeURIComponent(workspaceId)}`,
      init,
      usingServer,
      (t) => {
        ;(init.headers as Record<string, string>).Authorization = `Bearer ${t}`
      },
    )
    const data = await res.json().catch(() => ({}))

    // Log the change on success (after = the mapping we just wrote).
    if (res.ok) {
      const after = normalizeMapping((body as { esp_setting?: [] })?.esp_setting)
      await logEspChange(workspaceId, wsName, before, after, source, Date.now())
    }

    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'proxy error' }, { status: 502 })
  }
}
