import { NextResponse, type NextRequest } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import { verifyAccessJwt } from '@/lib/cf-access'

const SECRET = new TextEncoder().encode(
  process.env.PORTAL_JWT_SECRET ?? 'portal-dev-secret-change-in-prod'
)
const ADMIN_SECRET = new TextEncoder().encode(
  (process.env.PORTAL_JWT_SECRET ?? 'portal-dev-secret-change-in-prod') + '-admin'
)

const CLIENT_COOKIE = 'ottaly_portal_session'
const ADMIN_COOKIE = 'ottaly_portal_admin'

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Admin routes
  if (pathname.startsWith('/admin')) {
    if (pathname === '/admin/login' || pathname.startsWith('/api/admin/auth')) {
      return NextResponse.next()
    }
    const token = req.cookies.get(ADMIN_COOKIE)?.value
    if (token) {
      try {
        const { payload } = await jwtVerify(token, ADMIN_SECRET)
        if (payload.role === 'admin') return NextResponse.next()
      } catch {
        // expired or bad: fall through
      }
    }
    // No admin session, but Cloudflare Access has already signed this person in
    // to /admin: trust its (signature-checked) token and start one, so nobody
    // types the password a second time. The Access policy on /admin is the
    // list of who is an admin. Off unless the CF_ACCESS_* env vars are set.
    const email = await verifyAccessJwt(req.headers.get('cf-access-jwt-assertion'))
    if (email) {
      const minted = await new SignJWT({ role: 'admin', email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(ADMIN_SECRET)
      // Let this same request see the session, not only the next one.
      req.cookies.set(ADMIN_COOKIE, minted)
      const res = NextResponse.next({ request: { headers: req.headers } })
      res.cookies.set(ADMIN_COOKIE, minted, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      })
      return res
    }
    return NextResponse.redirect(new URL('/admin/login', req.url))
  }

  // Public client paths
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/invite') ||
    pathname.startsWith('/api/forgot') ||
    pathname.startsWith('/api/admin') ||
    // Crons + inbound webhooks authenticate themselves (?secret=CRON_SECRET /
    // HMAC). Let them through — otherwise middleware 307-redirects them to /login
    // and external schedulers (cron-job.org) that don't follow redirects fail.
    pathname.startsWith('/api/cron') ||
    pathname.startsWith('/api/webhooks')
  ) {
    return NextResponse.next()
  }

  // Client routes
  if (!pathname.startsWith('/api/portal')) {
    const token = req.cookies.get(CLIENT_COOKIE)?.value
    if (!token) return NextResponse.redirect(new URL('/login', req.url))
    try {
      await jwtVerify(token, SECRET)
      return NextResponse.next()
    } catch {
      return NextResponse.redirect(new URL('/login', req.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  // Exclude Next internals AND static public assets (logo SVGs, images, fonts).
  // Without the file-extension exclusion, a logged-out request for /ottaly-logo.svg
  // matched the client-route guard and 307-redirected to /login, so the login page's
  // own logo loaded an HTML page instead of the SVG and rendered as a broken image.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$).*)'],
}
