import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'
const FIN_COOKIE = 'ottaly_fin'

// Access model: EVERYTHING requires a login. Deny by default.
//
// This previously ran "pages open, writes closed" on the premise that CMs do not
// log in. That premise is obsolete — there is a CM role and a CM_KEY, so CMs can
// sign in — and the open pages meant dev.ottaly.co.uk served real client data to
// anyone who knew the hostname: /contacts returned contact PII (names, emails,
// employers, LinkedIn), /clients returned client names with volumes and reply
// rates. Subdomains are not secret; they show up in certificate-transparency
// logs. admin-legacy has always gated its whole site; this brings admin-new in
// line rather than leaving the newer app as the weaker door.
//
// Only PUBLIC_PATHS below stay reachable without a session. Adding to that list
// puts real client data back on the open internet — do not add a page to it.
//
// Finance + Revenue keep their separate FINANCE_KEY passphrase (12h unlock) ON
// TOP of the login. Settings + Commission require the admin role specifically.
const FINANCE_PATHS = ['/finance', '/revenue', '/api/finance', '/api/revenue']
const ADMIN_PATHS = [
  '/admin-settings',
  '/api/admin-settings',
  '/commission',
  '/api/commission',
  // Proxies to legacy admin endpoints, including client password writes.
  '/api/admin',
]

// The ONLY things reachable without a session. Everything else — every page and
// every API — needs the login. Each entry here is deliberate:
//   /login              the sign-in page itself, or there is no way in
//   /unlock             the finance passphrase prompt (its own gate)
//   /api/auth           mints the session; /api/auth/finance self-checks
//   /api/healthz        deploy verification (returns {ok, sha, ts, db} only)
//   /api/data/esp-matching/enforce  cron endpoint, validates ?key=ADMIN_KEY itself
// /api/metrics was public and is NOT any more — it exposed operational data with
// no login and nothing external scrapes it.
const PUBLIC_PATHS = [
  '/login',
  '/unlock',
  '/api/auth',
  '/api/healthz',
  '/api/data/esp-matching/enforce',
]

function matchesPrefix(pathname: string, paths: string[]): boolean {
  return paths.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // The sign-in page and the few self-protecting endpoints are the only way in.
  if (matchesPrefix(pathname, PUBLIC_PATHS)) {
    return NextResponse.next()
  }

  const needsFinance = matchesPrefix(pathname, FINANCE_PATHS)
  const needsAdmin = matchesPrefix(pathname, ADMIN_PATHS)

  // Everything else needs a valid session — pages and APIs alike.
  const token = req.cookies.get(COOKIE)?.value
  let sessionOk = false
  let role: string | null = null
  if (token) {
    try {
      const { payload } = await jwtVerify(token, SECRET)
      sessionOk = true
      // Tokens minted before roles existed carried role:'admin'.
      role = payload.role === 'cm' ? 'cm' : 'admin'
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

  // Admin-only areas (Settings, Commission, the legacy-admin proxies) need the
  // admin role specifically — a signed-in CM is not enough.
  if (needsAdmin && role !== 'admin') {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/', req.url))
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

// Everything except Next's own build assets goes through the gate. This is App
// Router, so there is no /_next/data — RSC navigation payloads arrive on the
// page's own path with ?_rsc=, which means they are gated too. Do not widen
// these exclusions: each one is a path that serves without a session.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
