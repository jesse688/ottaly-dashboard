import { type NextRequest, NextResponse } from 'next/server'
import { getSession, checkFinanceKey, createFinanceToken, isFinanceUnlocked, FIN_COOKIE } from '@/lib/auth'

// GET — is finance currently unlocked for this session?
export async function GET() {
  if (!await getSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ unlocked: await isFinanceUnlocked() })
}

// POST — unlock Finance/Revenue by entering the env FINANCE_KEY. Must already be
// logged in (so an outsider can't brute-force the key without a session). On
// success, sets a short-lived signed finance cookie that the middleware checks.
export async function POST(req: NextRequest) {
  if (!await getSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { key } = await req.json().catch(() => ({ key: '' }))
  if (!checkFinanceKey(String(key ?? ''))) {
    return NextResponse.json({ error: 'Incorrect finance key' }, { status: 401 })
  }
  const token = await createFinanceToken()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(FIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 12, // 12h, then re-enter
    path: '/',
  })
  return res
}

// DELETE — lock finance again (clears the unlock cookie).
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(FIN_COOKIE)
  return res
}
