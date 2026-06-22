import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/mailboxes/bulk-billing-rows { rows: [{ email, billing_start_date }] }
// Spreadsheet billing import: each row sets that mailbox's billing date (day
// derived from the date). Only updates mailboxes that exist. mailbox_meta +
// mailbox_full mirror.
export async function POST(req: Request) {
  try {
    const b = await req.json() as { rows?: { email?: string; billing_start_date?: string }[] }
    const rows = (b.rows || []).filter(r => r.email && r.billing_start_date)
    if (!rows.length) return NextResponse.json({ error: 'No valid rows' }, { status: 400 })

    let updated = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        const email = r.email!.toLowerCase()
        const day = new Date(r.billing_start_date!).getUTCDate()
        // Only apply to known mailboxes.
        const exists = await client.query(`SELECT 1 FROM mailbox_full WHERE lower(email) = $1`, [email])
        if (!exists.rows.length) continue
        await client.query(
          `INSERT INTO mailbox_meta (email, billing_start_date, billing_day, updated_at)
           VALUES ($1, $2::date, $3::int, now())
           ON CONFLICT (email) DO UPDATE SET billing_start_date = EXCLUDED.billing_start_date, billing_day = EXCLUDED.billing_day, updated_at = now()`,
          [email, r.billing_start_date, day]
        )
        await client.query(`UPDATE mailbox_full SET billing_start_date = $2::date, billing_day = $3::int WHERE lower(email) = $1`, [email, r.billing_start_date, day])
        updated++
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return NextResponse.json({ ok: true, updated, skipped: rows.length - updated })
  } catch (err) {
    console.error('[mailboxes/bulk-billing-rows]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
