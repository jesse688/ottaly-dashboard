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
