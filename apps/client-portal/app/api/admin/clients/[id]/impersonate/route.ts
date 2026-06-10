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
    `SELECT id, workspace_id, company_name, email FROM portal_clients WHERE id = $1`,
    [id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const c = r.rows[0]

  const token = await createClientSession({
    clientId: c.id,
    workspaceId: c.workspace_id,
    companyName: c.company_name,
    email: c.email,
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
