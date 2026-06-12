import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { createHash, randomBytes } from 'crypto'
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

export interface WorkspaceRef {
  clientId: string
  workspaceId: string
  companyName: string
}

export interface ClientSession {
  // ACTIVE workspace (every existing query uses these — shape unchanged).
  workspaceId: string
  companyName: string
  contactName: string
  email: string
  clientId: string
  // All workspaces this login can access (length 1 for legacy single-workspace
  // logins). The workspace switcher picks which is active.
  workspaces?: WorkspaceRef[]
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// Hash an access code. Normalised (trimmed + lowercased) so clients don't get
// locked out over capitalisation or stray spaces — "Gareth02" === "gareth02".
export function hashCode(code: string): string {
  return sha256(code.trim().toLowerCase())
}

// Unguessable token for a self-service invite link.
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url')
}

// Public base URL for building client-facing links. Behind Easypanel's proxy,
// req.url resolves to the internal bind (0.0.0.0:3001), so prefer an explicit
// env, then the forwarded host, then the known domain.
export function portalBaseUrl(req: Request): string {
  if (process.env.PORTAL_BASE_URL) return process.env.PORTAL_BASE_URL.replace(/\/$/, '')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  if (host && !/(^|\W)(0\.0\.0\.0|localhost|127\.0\.0\.1)/.test(host)) return `${proto}://${host}`
  return 'https://login.ottaly.co.uk'
}

// Friendly access code like "Otta-7K2P" — easy to read out, no ambiguous chars.
export function generateAccessCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `Otta-${s}`
}

// Log in with a username OR email as the identifier, plus the access code
// (stored hashed in password_hash). Existing email+password clients still work.
export async function validateClientCredentials(
  identifier: string,
  code: string
): Promise<ClientSession | null> {
  const id = identifier.trim()

  // 1) Multi-workspace logins: portal_user_access maps one identifier to one or
  //    more client workspaces. Accept the normalised OR exact-case hash.
  const access = await pool.query(
    `SELECT ua.password_hash, c.id AS client_id, c.workspace_id, c.company_name, c.contact_name, c.email
     FROM portal_user_access ua
     JOIN portal_clients c ON c.id = ua.client_id AND c.active = true
     WHERE lower(ua.identifier) = lower($1)
     ORDER BY c.company_name`,
    [id]
  )
  if (access.rows.length) {
    const ok = access.rows.some(r => r.password_hash === hashCode(code) || r.password_hash === sha256(code))
    if (!ok) return null
    const workspaces: WorkspaceRef[] = access.rows.map(r => ({
      clientId: r.client_id, workspaceId: r.workspace_id, companyName: r.company_name,
    }))
    const first = access.rows[0]
    return {
      clientId: first.client_id,
      workspaceId: first.workspace_id,
      companyName: first.company_name,
      contactName: first.contact_name ?? '',
      email: first.email ?? '',
      workspaces,
    }
  }

  // 2) Legacy single-workspace login on portal_clients (unchanged behaviour).
  const res = await pool.query(
    `SELECT id, workspace_id, company_name, contact_name, email, password_hash
     FROM portal_clients
     WHERE (lower(username) = lower($1) OR lower(email) = lower($1)) AND active = true
     LIMIT 1`,
    [id]
  )
  if (!res.rows.length) return null

  const row = res.rows[0] as {
    id: string
    workspace_id: string
    company_name: string
    contact_name: string | null
    email: string | null
    password_hash: string
  }
  const stored = row.password_hash ?? ''
  const matches = stored === hashCode(code) || stored === sha256(code)
  if (!matches) return null

  return {
    clientId: row.id,
    workspaceId: row.workspace_id,
    companyName: row.company_name,
    contactName: row.contact_name ?? '',
    email: row.email ?? '',
    workspaces: [{ clientId: row.id, workspaceId: row.workspace_id, companyName: row.company_name }],
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
      contactName: (payload.contactName as string) ?? '',
      email: payload.email as string,
      workspaces: (payload.workspaces as WorkspaceRef[] | undefined),
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
