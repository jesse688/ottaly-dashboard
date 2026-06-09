import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { createHash, timingSafeEqual } from 'crypto'
import pool from './db'

const SECRET = new TextEncoder().encode(
  process.env.PORTAL_JWT_SECRET ?? 'portal-dev-secret-change-in-prod'
)
const ADMIN_SECRET = new TextEncoder().encode(
  (process.env.PORTAL_JWT_SECRET ?? 'portal-dev-secret-change-in-prod') + '-admin'
)

export const COOKIE = 'ottaly_portal_session'
export const ADMIN_COOKIE = 'ottaly_portal_admin'
const ADMIN_KEY = process.env.PORTAL_ADMIN_KEY ?? 'Ottaly2025$'

export interface ClientSession {
  workspaceId: string
  companyName: string
  email: string
  clientId: string
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export async function validateClientCredentials(
  email: string,
  password: string
): Promise<ClientSession | null> {
  const res = await pool.query(
    `SELECT id, workspace_id, company_name, email, password_hash
     FROM portal_clients
     WHERE email = $1 AND active = true`,
    [email.toLowerCase()]
  )
  if (!res.rows.length) return null

  const row = res.rows[0] as {
    id: string
    workspace_id: string
    company_name: string
    email: string
    password_hash: string
  }

  const inputHash = Buffer.from(sha256(password))
  const storedHash = Buffer.from(row.password_hash)
  if (inputHash.length !== storedHash.length) return null
  try {
    if (!timingSafeEqual(inputHash, storedHash)) return null
  } catch {
    return null
  }

  return {
    clientId: row.id,
    workspaceId: row.workspace_id,
    companyName: row.company_name,
    email: row.email,
  }
}

export function validateAdminKey(key: string): boolean {
  return key === ADMIN_KEY
}

export async function createClientSession(session: ClientSession): Promise<string> {
  return new SignJWT({ ...session, role: 'client' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SECRET)
}

export async function createAdminSession(): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(ADMIN_SECRET)
}

export async function getSession(): Promise<ClientSession | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (payload.role !== 'client') return null
    return {
      clientId: payload.clientId as string,
      workspaceId: payload.workspaceId as string,
      companyName: payload.companyName as string,
      email: payload.email as string,
    }
  } catch {
    return null
  }
}

export async function getAdminSession(): Promise<boolean> {
  const store = await cookies()
  const token = store.get(ADMIN_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, ADMIN_SECRET)
    return payload.role === 'admin'
  } catch {
    return false
  }
}
