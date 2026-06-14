import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { generateInviteToken, portalBaseUrl } from '@/lib/auth'
import { sendEmail } from '@/lib/email'
import { notifyAdmin } from '@/lib/notify'

// POST — client forgot their code. Self-service: if the account exists, mint a
// fresh invite link and EMAIL it to them so they choose a new code, no admin
// needed. Handles both multi-workspace logins (portal_user_access) and legacy
// single logins (portal_clients). Always returns the same response so we don't
// reveal which accounts exist.
export async function POST(req: NextRequest) {
  const { username } = await req.json() as { username?: string }
  const id = (username ?? '').trim()
  if (!id) return NextResponse.json({ error: 'Enter your email' }, { status: 400 })

  const baseUrl = portalBaseUrl(req)

  // 1) Multi-workspace login? Reset the shared token across all their rows.
  const ua = await pool.query(
    `SELECT identifier FROM portal_user_access WHERE lower(identifier) = lower($1) LIMIT 1`,
    [id]
  )
  if (ua.rows.length) {
    const token = generateInviteToken()
    await pool.query(
      `UPDATE portal_user_access SET invite_token = $1 WHERE lower(identifier) = lower($2)`,
      [token, ua.rows[0].identifier]
    )
    await sendEmail(
      ua.rows[0].identifier,
      'Reset your Ottaly access code',
      `You asked to reset your Ottaly login code.\n\nChoose a new code here (link expires after use):\n${baseUrl}/invite/u/${token}\n\nIf you didn't request this, you can ignore this email.`,
    ).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  // 2) Legacy single login on portal_clients.
  const r = await pool.query(
    `SELECT id, company_name, email, COALESCE(username, email) AS login_email FROM portal_clients
     WHERE (lower(username) = lower($1) OR lower(email) = lower($1)) AND active = true LIMIT 1`,
    [id]
  )
  if (r.rows.length) {
    const c = r.rows[0]
    const token = generateInviteToken()
    await pool.query(`UPDATE portal_clients SET invite_token = $1 WHERE id = $2`, [token, c.id])
    const sent = c.email
      ? await sendEmail(
          c.email,
          'Reset your Ottaly access code',
          `You asked to reset your Ottaly login code.\n\nChoose a new code here (link expires after use):\n${baseUrl}/invite/${token}\n\nIf you didn't request this, you can ignore this email.`,
        ).catch(() => ({ ok: false }))
      : { ok: false }
    // Belt-and-braces: if we couldn't email them, fall back to alerting the team.
    if (!sent.ok) {
      await notifyAdmin({
        clientId: c.id,
        kind: 'login_help',
        title: `Code reset requested: ${c.company_name}`,
        body: `${c.login_email} requested a reset but we couldn't email them. Send them an invite link from Admin → Clients.`,
      }).catch(() => {})
    }
  }

  // Always the same response (don't leak which accounts exist).
  return NextResponse.json({ ok: true })
}
