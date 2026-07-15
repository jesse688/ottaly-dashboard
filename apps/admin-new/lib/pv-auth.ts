// ── PlusVibe server-side auth ────────────────────────────────────────────────
// Mints and caches a PlusVibe internal-API (api.pipl.ai) Bearer JWT by logging
// in with stored credentials, so server code (ESP writes, inbox-test) never needs
// a human to paste a token. The public x-api-key does NOT work for the ESP /
// workspace-setting endpoints (they 404), hence this login flow.
//
// Env (set in EasyPanel, never committed):
//   PLUSVIBE_LOGIN_EMAIL
//   PLUSVIBE_LOGIN_PASSWORD
//
// The token is cached in module memory and refreshed when it is missing, within
// 5 min of expiry, or after a caller reports a 401 (via invalidatePvJwt()).

const PIPL = 'https://api.pipl.ai/v1'

let cachedToken: string | null = null
let cachedExp = 0 // epoch ms; 0 = unknown
let inflight: Promise<string> | null = null

// Decode a JWT's exp (seconds) without verifying — just to know when to refresh.
function jwtExpMs(token: string): number {
  try {
    const payload = token.split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function login(): Promise<string> {
  const email = process.env.PLUSVIBE_LOGIN_EMAIL
  const password = process.env.PLUSVIBE_LOGIN_PASSWORD
  if (!email || !password) {
    throw new Error('PLUSVIBE_LOGIN_EMAIL / PLUSVIBE_LOGIN_PASSWORD not set')
  }
  const res = await fetch(`${PIPL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`PV login ${res.status}: ${data?.message ?? ''}`)
  const token: string | undefined = data?.data?.token ?? data?.token
  if (!token) throw new Error('PV login: no token in response')
  cachedToken = token
  cachedExp = jwtExpMs(token)
  return token
}

// Returns a valid PlusVibe JWT, logging in / refreshing as needed. Concurrent
// callers share one in-flight login.
export async function getPvJwt(): Promise<string> {
  const now = Date.now()
  // PlusVibe JWTs are short-lived (~12 min observed). Refresh with a 3-min safety
  // margin so a call never rides a near-dead token; login is cheap. If exp can't
  // be decoded (cachedExp === 0), always re-login to be safe.
  const stillFresh = cachedToken && cachedExp !== 0 && cachedExp - now > 3 * 60 * 1000
  if (stillFresh) return cachedToken as string
  if (inflight) return inflight
  inflight = login().finally(() => {
    inflight = null
  })
  return inflight
}

// Called by a consumer that just got a 401 with the cached token, forcing a
// fresh login on the next getPvJwt().
export function invalidatePvJwt(): void {
  cachedToken = null
  cachedExp = 0
}

// True when server creds are configured (so callers can decide whether to fall
// back to a user-supplied token).
export function hasPvCreds(): boolean {
  return !!(process.env.PLUSVIBE_LOGIN_EMAIL && process.env.PLUSVIBE_LOGIN_PASSWORD)
}
