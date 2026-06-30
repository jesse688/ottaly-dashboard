import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'
const FIN_COOKIE = 'ottaly_fin'

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/healthz']

// Finance + Revenue (pages and APIs) are gated by a SEPARATE env passphrase on
// top of login — ANYONE (admin or CM) must unlock with FINANCE_KEY to view them.
// Matched by prefix. The /unlock page and /api/auth/finance endpoint are NOT here.
const FINANCE_PATHS = ['/finance', '/revenue', '/api/finance', '/api/revenue']

function isFinancePath(pathname: string): boolean {
  return FINANCE_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const token = req.cookies.get(COOKIE)?.value

  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // Must be logged in.
  try {
    await jwtVerify(token, SECRET)
  } catch {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // Finance gate: viewing Finance/Revenue needs a valid finance-unlock cookie
  // (set by entering FINANCE_KEY), regardless of role. Without it: API → 403,
  // page → the /unlock prompt (which returns the user here after unlocking).
  if (isFinancePath(pathname)) {
    const fin = req.cookies.get(FIN_COOKIE)?.value
    let finOk = false
    if (fin) {
      try {
        const { payload } = await jwtVerify(fin, SECRET)
        finOk = payload.fin === true
      } catch {
        finOk = false
      }
    }
    if (!finOk) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Finance locked' }, { status: 403 })
      }
      const url = new URL('/unlock', req.url)
      url.searchParams.set('next', pathname)
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
