import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         email, supplier, mailbox_type, notes,
         billing_start_date, billing_day,
         ignored_at, created_at, updated_at
       FROM mailbox_meta
       ORDER BY supplier NULLS LAST, email`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[mailboxes]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
