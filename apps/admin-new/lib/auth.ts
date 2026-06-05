import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'ottaly-dev-secret-change-in-prod'
)
const COOKIE = 'ottaly_session'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'Ottaly345$'

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

export function checkAdminKey(key: string): boolean {
  return key === ADMIN_KEY
}

export { COOKIE }
