import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT
         c.id, c.name, c.workspace_id, c.status,
         c.vertical, c.monthly_value, c.start_date,
         c.contact_email, c.notes
       FROM clients c
       ORDER BY c.status, c.name`
    )
    return NextResponse.json(res.rows)
  } catch (err) {
    console.error('[clients]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
