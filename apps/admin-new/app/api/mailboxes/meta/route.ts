import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// PUT /api/mailboxes/meta { email, field, value } — update one mailbox_meta
// field (supplier | mailbox_type | notes) and mirror to mailbox_full so the UI
// reflects it immediately. Used by per-row inline supplier/type selects.
const ALLOWED = new Set(['supplier', 'mailbox_type', 'notes'])

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { email?: string; field?: string; value?: string | null }
    const email = (body.email || '').toLowerCase()
    const field = body.field || ''
    if (!email || !ALLOWED.has(field)) {
      return NextResponse.json({ error: 'Invalid email or field' }, { status: 400 })
    }
    const value = body.value || null
    const fullCol = field === 'mailbox_type' ? 'type' : field === 'supplier' ? 'supplier' : 'notes'

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO mailbox_meta (email, ${field}, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE SET ${field} = EXCLUDED.${field}, updated_at = now()`,
        [email, value]
      )
      await client.query(`UPDATE mailbox_full SET ${fullCol} = $2 WHERE lower(email) = $1`, [email, value])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mailboxes/meta]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
