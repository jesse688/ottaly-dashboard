import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/mailboxes/bulk-remove { emails[] } — soft-remove from the dashboard
// by setting ignored_at (mailbox_meta + mailbox_full). The page filters out
// ignored rows, so they vanish until un-ignored / re-synced.
export async function POST(req: Request) {
  try {
    const b = await req.json() as { emails?: string[] }
    const emails = (b.emails || []).map(e => e.toLowerCase())
    if (!emails.length) return NextResponse.json({ error: 'No mailboxes selected' }, { status: 400 })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO mailbox_meta (email, ignored_at, updated_at)
         SELECT unnest($1::text[]), now(), now()
         ON CONFLICT (email) DO UPDATE SET ignored_at = now(), updated_at = now()`,
        [emails]
      )
      await client.query(`UPDATE mailbox_full SET ignored_at = now() WHERE lower(email) = ANY($1::text[])`, [emails])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    return NextResponse.json({ ok: true, removed: emails.length })
  } catch (err) {
    console.error('[mailboxes/bulk-remove]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
