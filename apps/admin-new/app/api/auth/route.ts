import { type NextRequest, NextResponse } from 'next/server'
import { createSession, roleForKey, COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { key } = await req.json()

  const role = roleForKey(key)
  if (!role) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 401 })
  }

  const token = await createSession(role)
  const res = NextResponse.json({ ok: true, role })
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
