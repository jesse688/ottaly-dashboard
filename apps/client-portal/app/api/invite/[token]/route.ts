import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import pool from '@/lib/db'
import { sha256, createClientSession, COOKIE } from '@/lib/auth'

// GET — validate an invite token; return the company name for display.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const r = await pool.query(
    `SELECT company_name FROM portal_clients WHERE invite_token = $1 AND active = true LIMIT 1`,
    [token]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })
  return NextResponse.json({ companyName: r.rows[0].company_name })
}

// POST — client claims the invite: sets their own username + code, then is logged in.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { username, code } = await req.json() as { username?: string; code?: string }
  const u = (username ?? '').trim()
  const c = (code ?? '').trim()
  if (u.length < 3) return NextResponse.json({ error: 'Choose a username (min 3 characters).' }, { status: 400 })
  if (c.length < 4) return NextResponse.json({ error: 'Choose a code (min 4 characters).' }, { status: 400 })

  const r = await pool.query(
    `SELECT id, workspace_id, company_name, email FROM portal_clients
     WHERE invite_token = $1 AND active = true LIMIT 1`,
    [token]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'This invite link is invalid or has already been used.' }, { status: 404 })
  const client = r.rows[0]

  try {
    await pool.query(
      `UPDATE portal_clients SET username = $1, password_hash = $2, invite_token = NULL WHERE id = $3`,
      [u, sha256(c), client.id]
    )
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') return NextResponse.json({ error: 'That username is taken — try another.' }, { status: 409 })
    throw err
  }

  // Log them straight in.
  const tok = await createClientSession({ clientId: client.id, workspaceId: client.workspace_id, companyName: client.company_name, email: client.email ?? '' })
  const store = await cookies()
  store.set(COOKIE, tok, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 })
  return NextResponse.json({ ok: true })
}
