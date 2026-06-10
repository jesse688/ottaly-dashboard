import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — all top-up requests (newest first) with client name
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(
    `SELECT t.id, t.client_id, t.amount, t.status, t.note, t.created_at, t.confirmed_at,
            c.company_name, c.email
       FROM portal_topup_requests t
       JOIN portal_clients c ON c.id = t.client_id
      ORDER BY (t.status = 'pending') DESC, t.created_at DESC`
  )
  return NextResponse.json(r.rows)
}
