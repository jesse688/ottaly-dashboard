import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

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
    if (!token) return NextResponse.redirect(new URL('/admin/login', req.url))
    try {
      const { payload } = await jwtVerify(token, ADMIN_SECRET)
      if (payload.role !== 'admin') throw new Error()
      return NextResponse.next()
    } catch {
      return NextResponse.redirect(new URL('/admin/login', req.url))
    }
  }

  // Public client paths
  if (pathname.startsWith('/login') || pathname.startsWith('/api/auth') || pathname.startsWith('/api/admin')) {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
