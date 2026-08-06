import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'
const FIN_COOKIE = 'ottaly_fin'

// Access model: PAGES are open, WRITES are not.
//
// CMs do not log in, so every *page* renders without a session. But the API is
// deny-by-default: any request that can mutate data, spend money, send mail or
// expose credentials still requires the admin login. Read-only GETs stay open so
// the public pages can fetch their data.
//
// Rationale: a public page is a disclosure risk; a public POST/DELETE is a live
// production hazard (contact deletion, campaign injection, paid-API spend). The
// two are separated deliberately — do NOT collapse them back together.
//
// Finance + Revenue keep their separate FINANCE_KEY passphrase (12h unlock).
// Settings + Commission require the normal admin login.
const FINANCE_PATHS = ['/finance', '/revenue', '/api/finance', '/api/revenue']
const ADMIN_PATHS = [
  '/admin-settings',
  '/api/admin-settings',
  '/commission',
  '/api/commission',
  // Proxies to legacy admin endpoints, including client password writes.
  '/api/admin',
]

// APIs that stay fully open regardless of method — they self-protect or are
// needed to sign in. /api/auth mints sessions; /api/auth/finance checks its own
// session internally; the cron enforce endpoint validates ?key=ADMIN_KEY itself.
const OPEN_API_PATHS = [
  '/api/auth',
  '/api/healthz',
  '/api/metrics',
  '/api/data/esp-matching/enforce',
]

// Read-only GETs are public (pages need them), but these leak credentials or raw
// upstream payloads, so they require a login even for GET.
const SENSITIVE_GET_PATHS = [
  '/api/debug',
  '/api/stats/debug',
  '/api/stats/reconcile',
  '/api/mailboxes/tags-debug',
  '/api/mailboxes/mb-debug',
  // Bulk PII exports — full contact/lead dumps.
  '/api/database/contacts',
  '/api/data/database/contacts',
  '/api/data/contacts/export',
  '/api/data/engine-leads/export',
  '/api/apollo-prep/contacts/export',
]

function matchesPrefix(pathname: string, paths: string[]): boolean {
  return paths.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  const needsFinance = matchesPrefix(pathname, FINANCE_PATHS)
  let needsAdmin = matchesPrefix(pathname, ADMIN_PATHS)

  // API deny-by-default: everything except safe read-only GETs needs a login.
  if (!needsFinance && !needsAdmin && pathname.startsWith('/api/')) {
    if (!matchesPrefix(pathname, OPEN_API_PATHS)) {
      const isRead = req.method === 'GET' || req.method === 'HEAD'
      if (!isRead || matchesPrefix(pathname, SENSITIVE_GET_PATHS)) {
        needsAdmin = true
      }
    }
  }

  // Pages (and safe read-only API GETs) are public — no session required.
  if (!needsFinance && !needsAdmin) {
    return NextResponse.next()
  }

  // Gated routes still require a valid login session.
  const token = req.cookies.get(COOKIE)?.value
  let sessionOk = false
  if (token) {
    try {
      await jwtVerify(token, SECRET)
      sessionOk = true
    } catch {
      sessionOk = false
    }
  }
  if (!sessionOk) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const url = new URL('/login', req.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  // Finance gate: viewing Finance/Revenue needs a valid finance-unlock cookie
  // (set by entering FINANCE_KEY), regardless of role. Without it: API → 403,
  // page → the /unlock prompt (which returns the user here after unlocking).
  if (needsFinance) {
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
