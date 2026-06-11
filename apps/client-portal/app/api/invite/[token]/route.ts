import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { hashCode, createClientSession, COOKIE } from '@/lib/auth'

// GET — validate an invite token; return company + the login email to display.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const r = await pool.query(
    `SELECT company_name, COALESCE(username, email) AS login_email FROM portal_clients WHERE invite_token = $1 AND active = true LIMIT 1`,
    [token]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })
  return NextResponse.json({ companyName: r.rows[0].company_name, email: r.rows[0].login_email })
}

// POST — client claims the invite: sets their own access code, then is logged in.
// Their login identifier (email) is already set by the admin.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { code } = await req.json() as { code?: string }
  const c = (code ?? '').trim()
  if (c.length < 3) return NextResponse.json({ error: 'Choose a code with at least 3 characters.' }, { status: 400 })

  const r = await pool.query(
    `SELECT id, workspace_id, company_name, contact_name, email FROM portal_clients
     WHERE invite_token = $1 AND active = true LIMIT 1`,
    [token]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })
  const client = r.rows[0]

  await pool.query(
    `UPDATE portal_clients SET password_hash = $1, invite_token = NULL WHERE id = $2`,
    [hashCode(c), client.id]
  )

  // Log them straight in — set the cookie ON the response so it reliably attaches.
  const tok = await createClientSession({ clientId: client.id, workspaceId: client.workspace_id, companyName: client.company_name, contactName: client.contact_name ?? '', email: client.email ?? '' })
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, tok, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 })
  return res
}
