import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const [comp, dir, last, emails, pushed] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM ch_companies'),
      pool.query('SELECT COUNT(*) as total FROM ch_directors'),
      pool.query('SELECT MAX(updated_at) as last_import FROM ch_companies'),
      pool.query(
        "SELECT COUNT(*) as total FROM ch_directors WHERE email IS NOT NULL AND email_status IN ('safe','safe_catchall')"
      ),
      pool.query(
        'SELECT COUNT(*) as total FROM ch_directors WHERE pushed_to_bison_at IS NOT NULL'
      ),
    ])
    return NextResponse.json({
      total_companies: Number(comp.rows[0].total),
      total_directors: Number(dir.rows[0].total),
      last_import: last.rows[0].last_import,
      emails_verified: Number(emails.rows[0].total),
      pushed_to_bison: Number(pushed.rows[0].total),
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
