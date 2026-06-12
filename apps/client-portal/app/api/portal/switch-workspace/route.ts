import { NextResponse, type NextRequest } from 'next/server'
import { getSession, createClientSession, COOKIE } from '@/lib/auth'

// Switch the active workspace for a multi-workspace login. Validates the target
// is one this login can access, then re-issues the session cookie with that
// workspace active (so every existing query, which uses session.workspaceId,
// now reads the chosen workspace).
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const target = String(body?.workspaceId || '')
  const ws = (session.workspaces || []).find(w => w.workspaceId === target)
  if (!ws) return NextResponse.json({ error: 'No access to that workspace' }, { status: 403 })

  const token = await createClientSession({
    ...session,
    clientId: ws.clientId,
    workspaceId: ws.workspaceId,
    companyName: ws.companyName,
  })
  const res = NextResponse.json({ ok: true, workspaceId: ws.workspaceId, companyName: ws.companyName })
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })
  return res
}
