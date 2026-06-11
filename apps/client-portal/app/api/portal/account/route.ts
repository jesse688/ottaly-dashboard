import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hashCode } from '@/lib/auth'
import pool from '@/lib/db'

// GET — the logged-in client's editable profile fields.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const r = await pool.query(
    `SELECT username, email, contact_name, company_name FROM portal_clients WHERE id = $1`,
    [session.clientId]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const c = r.rows[0]
  return NextResponse.json({
    username: c.username ?? '',
    email: c.email ?? '',
    contactName: c.contact_name ?? '',
    companyName: c.company_name ?? '',
  })
}

// PATCH — client self-service update of contact name, login email, and/or access code.
export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const b = await req.json() as { contactName?: string; email?: string; newCode?: string }

  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1

  if (b.contactName !== undefined) {
    sets.push(`contact_name = $${i++}`)
    vals.push(b.contactName.trim() || null)
  }

  if (b.email !== undefined) {
    const email = b.email.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
    }
    // Email doubles as the login username — make sure it's not taken by another client.
    const clash = await pool.query(
      `SELECT 1 FROM portal_clients WHERE id <> $1 AND (lower(email) = $2 OR lower(username) = $2) LIMIT 1`,
      [session.clientId, email]
    )
    if (clash.rows.length) {
      return NextResponse.json({ error: 'That email is already in use on another account.' }, { status: 409 })
    }
    sets.push(`email = $${i++}`, `username = $${i++}`)
    vals.push(email, email)
  }

  if (b.newCode !== undefined && b.newCode !== '') {
    const code = b.newCode.trim()
    if (code.length < 3) {
      return NextResponse.json({ error: 'Choose an access code with at least 3 characters.' }, { status: 400 })
    }
    sets.push(`password_hash = $${i++}`)
    vals.push(hashCode(code))
  }

  if (!sets.length) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })

  vals.push(session.clientId)
  try {
    await pool.query(`UPDATE portal_clients SET ${sets.join(', ')} WHERE id = $${i}`, vals)
  } catch (err) {
    console.error('[portal/account] update failed:', err)
    return NextResponse.json({ error: 'Could not save changes. Please try again.' }, { status: 500 })
  }

  // Email change moves the login identifier — flag it so the client re-logs in.
  const emailChanged = b.email !== undefined && b.email.trim().toLowerCase() !== session.email.toLowerCase()
  return NextResponse.json({ ok: true, emailChanged })
}
