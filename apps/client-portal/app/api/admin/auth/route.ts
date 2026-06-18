import { NextResponse, type NextRequest } from 'next/server'
import { validateAdminKey, createAdminSession, ADMIN_COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { password } = await req.json() as { password: string }
  if (!validateAdminKey(password)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }
  const token = await createAdminSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, '', { maxAge: 0, path: '/' })
  return res
}
