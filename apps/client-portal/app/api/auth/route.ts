import { NextResponse, type NextRequest } from 'next/server'
import { validateClientCredentials, createClientSession, COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const body = await req.json() as { username?: string; code?: string; email?: string; password?: string }
  const identifier = (body.username ?? body.email ?? '').trim()
  const code = body.code ?? body.password ?? ''
  if (!identifier || !code) {
    return NextResponse.json({ error: 'Username and code required' }, { status: 400 })
  }

  const session = await validateClientCredentials(identifier, code)
  if (!session) {
    return NextResponse.json({ error: 'Invalid username or code' }, { status: 401 })
  }

  const token = await createClientSession(session)
  const res = NextResponse.json({ ok: true, companyName: session.companyName })
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })
  return res
}
