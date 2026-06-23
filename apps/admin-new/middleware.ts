import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/healthz']

// Paths CMs may NOT access: Finance + Revenue (pages and their APIs). CMs KEEP
// Commission. Admin sees everything. Matched by prefix.
const CM_BLOCKED = ['/finance', '/revenue', '/api/finance', '/api/revenue']

function isBlockedForCm(pathname: string): boolean {
  return CM_BLOCKED.some(p => pathname === p || pathname.startsWith(p + '/'))
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

  let role: string = 'admin'
  try {
    const { payload } = await jwtVerify(token, SECRET)
    // Legacy tokens (no role claim) are treated as admin.
    role = payload.role === 'cm' ? 'cm' : 'admin'
  } catch {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // Role gate: CMs are blocked from Finance + Revenue.
  if (role === 'cm' && isBlockedForCm(pathname)) {
    // API → 403 JSON; page → bounce to a page CMs can see.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/stats', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
