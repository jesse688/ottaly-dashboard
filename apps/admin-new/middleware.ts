import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'

// PlusVibe posts bounce webhooks to /api/mailbox-health/bounce-webhook
// unauthenticated, so it has to be reachable without a session. The route
// validates callers itself against PV_WEBHOOK_SECRET and only ever INSERTs a
// bounce event — it reads nothing and changes no settings.
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/healthz', '/api/mailbox-health/bounce-webhook']

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

  try {
    await jwtVerify(token, SECRET)
    return NextResponse.next()
  } catch {
    return NextResponse.redirect(new URL('/login', req.url))
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
