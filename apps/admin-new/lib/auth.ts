import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — refusing to start without a signing secret')
}
const SECRET = new TextEncoder().encode(JWT_SECRET)
const COOKIE = 'ottaly_session'

const ADMIN_KEY = process.env.ADMIN_KEY
if (!ADMIN_KEY) {
  throw new Error('ADMIN_KEY is not set — refusing to start without an admin key')
}

export async function createSession() {
  const token = await new SignJWT({ role: 'admin' })
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

export function checkAdminKey(key: unknown): boolean {
  if (typeof key !== 'string') return false
  const a = new TextEncoder().encode(key)
  const b = new TextEncoder().encode(ADMIN_KEY)
  // Compare every byte regardless of mismatch so timing does not leak the key.
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export { COOKIE }
