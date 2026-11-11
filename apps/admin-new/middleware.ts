import { NextResponse, type NextRequest } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import { verifyAccessJwt, accessLevelForEmail } from '@/lib/cf-access'

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
// Closed outright to an Access 'staff' session (no passphrase opens them).
const MONEY_PATHS = [...FINANCE_PATHS, '/commission', '/api/commission']
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
  // PlusVibe posts bounce webhooks here unauthenticated. The route validates
  // callers itself against PV_WEBHOOK_SECRET, the same way esp-matching/enforce
  // checks ADMIN_KEY, and only ever INSERTs a bounce event — it reads nothing
  // and returns no client data.
  '/api/mailbox-health/bounce-webhook',
  // One-off history import. Validates ?key=ADMIN_KEY itself, same as
  // esp-matching/enforce — it exists so a write-capable database credential
  // never has to leave the server.
  '/api/mailbox-health/import-history',
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
  // From an Access sign-in: 'full' skips the finance passphrase, 'staff' never
  // sees money pages. Key logins carry neither and behave as before.
  let financeAuto = false
  let noMoney = false
  if (token) {
    try {
      const { payload } = await jwtVerify(token, SECRET)
      sessionOk = true
      // Tokens minted before roles existed carried role:'admin'.
      role = payload.role === 'cm' ? 'cm' : 'admin'
      financeAuto = payload.access === 'full'
      noMoney = payload.access === 'staff'
    } catch {
      sessionOk = false
    }
  }
  // No session of our own, but Cloudflare Access has already signed this person
  // in: trust its (signature-checked) token and start a session, so nobody
  // types the key a second time. Off unless the CF_ACCESS_* env vars are set.
  let minted: string | null = null
  if (!sessionOk) {
    const email = await verifyAccessJwt(req.headers.get('cf-access-jwt-assertion'))
    if (email) {
      const access = accessLevelForEmail(email)
      role = 'admin'
      financeAuto = access === 'full'
      noMoney = access === 'staff'
      minted = await new SignJWT({ role, email, access })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(SECRET)
      sessionOk = true
      // Let this same request see the new session, not only the next one.
      req.cookies.set(COOKIE, minted)
    }
  }
  const withSession = (res: NextResponse) => {
    if (minted) {
      res.cookies.set(COOKIE, minted, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      })
    }
    return res
  }
  if (!sessionOk) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const url = new URL('/login', req.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (noMoney && matchesPrefix(pathname, MONEY_PATHS)) {
    if (pathname.startsWith('/api/')) {
      return withSession(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    }
    return withSession(NextResponse.redirect(new URL('/', req.url)))
  }

  // Admin-only areas (Settings, Commission, the legacy-admin proxies) need the
  // admin role specifically — a signed-in CM is not enough.
  if (needsAdmin && role !== 'admin') {
    if (pathname.startsWith('/api/')) {
      return withSession(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    }
    return withSession(NextResponse.redirect(new URL('/', req.url)))
  }

  // Finance gate: viewing Finance/Revenue needs a valid finance-unlock cookie
  // (set by entering FINANCE_KEY), regardless of role. Without it: API → 403,
  // page → the /unlock prompt (which returns the user here after unlocking).
  if (needsFinance && !financeAuto) {
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
        return withSession(NextResponse.json({ error: 'Finance locked' }, { status: 403 }))
      }
      const url = new URL('/unlock', req.url)
      url.searchParams.set('next', pathname)
      return withSession(NextResponse.redirect(url))
    }
  }

  const forward = { request: { headers: req.headers } }
  // The app launcher can have its own hostname (HUB_HOST, e.g. home.ottaly.co.uk)
  // pointed at this service: its bare address shows /home.
  const hubHost = process.env.HUB_HOST
  if (hubHost && pathname === '/' && req.headers.get('host')?.split(':')[0] === hubHost) {
    return withSession(NextResponse.rewrite(new URL('/home', req.url), forward))
  }
  return withSession(NextResponse.next(forward))
}

// Everything except Next's own build assets goes through the gate. This is App
// Router, so there is no /_next/data — RSC navigation payloads arrive on the
// page's own path with ?_rsc=, which means they are gated too. Do not widen
// these exclusions: each one is a path that serves without a session.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
