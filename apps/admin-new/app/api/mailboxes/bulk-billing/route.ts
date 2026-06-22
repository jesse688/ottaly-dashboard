import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/mailboxes/bulk-billing
//   { billing_start_date, billing_day?, emails? , supplier? }
// Sets billing dates for: the given emails, OR all mailboxes for a supplier,
// OR all mailboxes (when neither emails nor supplier given). billing_day
// defaults to the day-of-month of billing_start_date. Writes mailbox_meta +
// mirrors mailbox_full.
export async function POST(req: Request) {
  try {
    const b = await req.json() as { billing_start_date?: string; billing_day?: number; emails?: string[]; supplier?: string }
    if (!b.billing_start_date) return NextResponse.json({ error: 'billing_start_date required' }, { status: 400 })
    const day = b.billing_day && b.billing_day >= 1 && b.billing_day <= 31
      ? b.billing_day
      : new Date(b.billing_start_date).getUTCDate()

    // Resolve target emails.
    let emails: string[] = []
    if (Array.isArray(b.emails) && b.emails.length) {
      emails = b.emails.map(e => e.toLowerCase())
    } else if (b.supplier) {
      const r = await pool.query(`SELECT email FROM mailbox_full WHERE supplier = $1`, [b.supplier])
      emails = r.rows.map(x => x.email)
    } else {
      const r = await pool.query(`SELECT email FROM mailbox_full WHERE ignored_at IS NULL`)
      emails = r.rows.map(x => x.email)
    }
    if (!emails.length) return NextResponse.json({ ok: true, updated: 0 })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO mailbox_meta (email, billing_start_date, billing_day, updated_at)
         SELECT unnest($1::text[]), $2::date, $3::int, now()
         ON CONFLICT (email) DO UPDATE SET billing_start_date = EXCLUDED.billing_start_date, billing_day = EXCLUDED.billing_day, updated_at = now()`,
        [emails, b.billing_start_date, day]
      )
      await client.query(
        `UPDATE mailbox_full SET billing_start_date = $2::date, billing_day = $3::int WHERE lower(email) = ANY($1::text[])`,
        [emails, b.billing_start_date, day]
      )
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return NextResponse.json({ ok: true, updated: emails.length })
  } catch (err) {
    console.error('[mailboxes/bulk-billing]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
