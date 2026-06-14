import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { hashCode, createClientSession, COOKIE, type WorkspaceRef } from '@/lib/auth'

// Self-service invite for a MULTI-WORKSPACE login (portal_user_access).
// The token is shared across every row for one identifier, so claiming it sets
// the code for all the workspaces that login can reach.

// GET — validate the token; show the identifier + which companies it unlocks.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const r = await pool.query(
    `SELECT ua.identifier, c.company_name
       FROM portal_user_access ua
       JOIN portal_clients c ON c.id = ua.client_id AND c.active = true
      WHERE ua.invite_token = $1
      ORDER BY c.company_name`,
    [token]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })
  return NextResponse.json({
    email: r.rows[0].identifier,
    companyName: r.rows.map(x => x.company_name).join(' + '),
  })
}

// POST { code } — set the code on every row for this token, clear the token,
// then log the user in with all their workspaces.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { code } = await req.json() as { code?: string }
  const c = (code ?? '').trim()
  if (c.length < 3) return NextResponse.json({ error: 'Choose a code with at least 3 characters.' }, { status: 400 })

  const rows = await pool.query(
    `SELECT ua.identifier, c.id AS client_id, c.workspace_id, c.company_name, c.contact_name, c.email
       FROM portal_user_access ua
       JOIN portal_clients c ON c.id = ua.client_id AND c.active = true
      WHERE ua.invite_token = $1
      ORDER BY c.company_name`,
    [token]
  )
  if (!rows.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })

  const identifier = rows.rows[0].identifier
  await pool.query(
    `UPDATE portal_user_access SET password_hash = $1, invite_token = NULL
      WHERE lower(identifier) = lower($2)`,
    [hashCode(c), identifier]
  )

  const workspaces: WorkspaceRef[] = rows.rows.map(r => ({
    clientId: r.client_id, workspaceId: r.workspace_id, companyName: r.company_name,
  }))
  const first = rows.rows[0]
  const tok = await createClientSession({
    clientId: first.client_id, workspaceId: first.workspace_id,
    companyName: first.company_name, contactName: first.contact_name ?? '',
    email: first.email ?? '', workspaces,
  })
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, tok, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 })
  return res
}
