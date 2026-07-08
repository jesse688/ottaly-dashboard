import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { getAdminSession, createClientSession, COOKIE } from '@/lib/auth'
import pool from '@/lib/db'

// POST — admin "View as client". Mints a client session for the chosen client and
// sets the client cookie, so the admin can open /unibox and see exactly what that
// client sees. The admin cookie is separate, so the admin stays logged in too.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const r = await pool.query(
    `SELECT id, workspace_id, company_name, contact_name, email FROM portal_clients WHERE id = $1`,
    [id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const c = r.rows[0]

  // Mirror what a real multi-workspace login sees: every workspace reachable by
  // any user of this client. Without this the "View as" session has no
  // `workspaces`, so the header switcher never renders even when the client's
  // users can switch. Falls back to the single client when it has no
  // portal_user_access rows (legacy single-workspace client).
  const ws = await pool.query(
    `SELECT DISTINCT c.id AS client_id, c.workspace_id, c.company_name
       FROM portal_user_access ua
       JOIN portal_clients c ON c.id = ua.client_id AND c.active = true
      WHERE lower(ua.identifier) IN (
              SELECT lower(identifier) FROM portal_user_access WHERE client_id = $1)
      ORDER BY c.company_name`,
    [id]
  )
  const workspaces = ws.rows.length
    ? ws.rows.map(w => ({ clientId: w.client_id, workspaceId: w.workspace_id, companyName: w.company_name }))
    : [{ clientId: c.id, workspaceId: c.workspace_id, companyName: c.company_name }]

  const token = await createClientSession({
    clientId: c.id,
    workspaceId: c.workspace_id,
    companyName: c.company_name,
    contactName: c.contact_name ?? '',
    email: c.email,
    workspaces,
  })

  const store = await cookies()
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 4, // 4h impersonation window
  })

  return NextResponse.json({ ok: true })
}
