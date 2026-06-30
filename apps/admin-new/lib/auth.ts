import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'Ottaly345$'
// Content-Manager key. CMs see everything EXCEPT Finance + Revenue (they keep
// Commission). Override via env in prod; the default is dev-only.
const CM_KEY = process.env.CM_KEY ?? 'OttalyCM345$'

export type Role = 'admin' | 'cm'

// ── Finance lock (Model B) ───────────────────────────────────────────────────
// Finance + Revenue are gated by a SEPARATE passphrase held only in env, on top
// of the normal login. Anyone (even an admin) must enter FINANCE_KEY once to
// unlock; it sets a short-lived signed cookie. No fallback: if FINANCE_KEY is
// unset, finance stays locked for everyone (fail closed).
const FIN_COOKIE = 'ottaly_fin'
const FINANCE_KEY = process.env.FINANCE_KEY

export function checkFinanceKey(key: string): boolean {
  return !!FINANCE_KEY && key === FINANCE_KEY
}

// Mint a finance-unlock token (12h). Signed with the same secret so the Edge
// middleware can verify it without a DB/network call.
export async function createFinanceToken() {
  return new SignJWT({ fin: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(SECRET)
}

export async function isFinanceUnlocked(): Promise<boolean> {
  const store = await cookies()
  const token = store.get(FIN_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return payload.fin === true
  } catch {
    return false
  }
}

export { FIN_COOKIE }

export async function createSession(role: Role = 'admin') {
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET)
  return token
}

export async function verifySession(token: string) {
  try {
    await jwtVerify(token, SECRET)
    return true
  } catch {
    return false
  }
}

export async function getSession(): Promise<boolean> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return false
  return verifySession(token)
}

// The signed-in role, or null if no valid session. Defaults to 'admin' for
// legacy tokens minted before roles existed (they carried role:'admin').
export async function getRole(): Promise<Role | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return payload.role === 'cm' ? 'cm' : 'admin'
  } catch {
    return null
  }
}

// Resolve a login key to a role, or null if it matches neither key.
export function roleForKey(key: string): Role | null {
  if (key === ADMIN_KEY) return 'admin'
  if (key === CM_KEY) return 'cm'
  return null
}

export function checkAdminKey(key: string): boolean {
  return key === ADMIN_KEY
}

export { COOKIE }
