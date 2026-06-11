import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — the payment instructions + optional pay link shown to the client when
// they go to pay an invoice. Set globally by admin (master setting).
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(`SELECT key, value FROM portal_settings WHERE key IN ('payment_instructions', 'payment_link')`)
  const map: Record<string, string> = {}
  for (const row of r.rows) map[row.key] = row.value ?? ''
  return NextResponse.json({
    instructions: map.payment_instructions ?? '',
    link: map.payment_link ?? '',
  })
}
