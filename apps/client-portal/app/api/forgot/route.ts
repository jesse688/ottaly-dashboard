import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { notifyAdmin } from '@/lib/notify'

// POST — client forgot their code. Doesn't reveal whether the account exists;
// if it does, notify the team to send a NEW invite link so they re-set a code.
export async function POST(req: NextRequest) {
  const { username } = await req.json() as { username?: string }
  const id = (username ?? '').trim()
  if (!id) return NextResponse.json({ error: 'Enter your email' }, { status: 400 })

  const r = await pool.query(
    `SELECT id, company_name, COALESCE(username, email) AS login_email FROM portal_clients
     WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [id]
  )
  if (r.rows.length) {
    const c = r.rows[0]
    await notifyAdmin({
      clientId: c.id,
      kind: 'login_help',
      title: `Code reset requested: ${c.company_name}`,
      body: `${c.login_email} forgot their code and needs a new login link.\nGo to Admin → Clients → "Invite link" for them, and send them the new link so they can set a new code.`,
    })
  }
  // Always the same response (don't leak which accounts exist).
  return NextResponse.json({ ok: true })
}
