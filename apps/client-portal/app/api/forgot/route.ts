import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// POST — client forgot their code. Doesn't reveal whether the account exists;
// if it does, notify the team to resend the code (no email dependency).
export async function POST(req: NextRequest) {
  const { username } = await req.json() as { username?: string }
  const id = (username ?? '').trim()
  if (!id) return NextResponse.json({ error: 'Enter your username' }, { status: 400 })

  const r = await pool.query(
    `SELECT id, company_name, username FROM portal_clients
     WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [id]
  )
  if (r.rows.length) {
    const c = r.rows[0]
    await notifyAdmin({
      clientId: c.id,
      kind: 'login_help',
      title: `Login help: ${c.company_name} forgot their code`,
      body: `Username: ${c.username ?? '—'}\nThey requested their access code. Resend it from Admin → Clients → Reset code.`,
    })
  }
  // Always the same response (don't leak which accounts exist).
  return NextResponse.json({ ok: true })
}
