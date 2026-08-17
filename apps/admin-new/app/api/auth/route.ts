import { type NextRequest, NextResponse } from 'next/server'
import { createSession, checkAdminKey, COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  let key: unknown
  try {
    ({ key } = await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  if (!checkAdminKey(key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 401 })
  }

  const token = await createSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE)
  return res
}
