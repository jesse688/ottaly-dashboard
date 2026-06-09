import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { createHash, timingSafeEqual } from 'crypto'

const SECRET = new TextEncoder().encode(
  process.env.PORTAL_JWT_SECRET ?? 'portal-dev-secret-change-in-prod'
)
export const COOKIE = 'ottaly_portal_session'

export interface ClientSession {
  workspaceId: string
  companyName: string
  email: string
}

interface PortalClient {
  email: string
  passwordHash: string
  workspaceId: string
  companyName: string
}

function getClients(): PortalClient[] {
  try {
    const raw = process.env.PORTAL_CLIENTS_JSON ?? '[]'
    return JSON.parse(raw) as PortalClient[]
  } catch {
    return []
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function validateCredentials(email: string, password: string): ClientSession | null {
  const clients = getClients()
  const client = clients.find(c => c.email.toLowerCase() === email.toLowerCase())
  if (!client) return null

  const inputHash = Buffer.from(sha256(password))
  const storedHash = Buffer.from(client.passwordHash)
  if (inputHash.length !== storedHash.length) return null

  try {
    if (!timingSafeEqual(inputHash, storedHash)) return null
  } catch {
    return null
  }

  return {
    workspaceId: client.workspaceId,
    companyName: client.companyName,
    email: client.email,
  }
}

export async function createSession(session: ClientSession): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SECRET)
}

export async function getSession(): Promise<ClientSession | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return {
      workspaceId: payload.workspaceId as string,
      companyName: payload.companyName as string,
      email: payload.email as string,
    }
  } catch {
    return null
  }
}
