import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Read stored owners/directors for the given company numbers (cn=...&cn=... or cn[]=...).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const cns = [
    ...searchParams.getAll('cn[]'),
    ...searchParams.getAll('cn'),
  ].filter(Boolean)
  if (!cns.length) {
    return NextResponse.json({ error: 'cn[] required' }, { status: 400 })
  }
  try {
    const placeholders = cns.map((_, i) => `$${i + 1}`).join(',')
    const rows = await pool.query(
      `SELECT d.*, c.company_name FROM ch_directors d JOIN ch_companies c ON c.company_number=d.company_number WHERE d.company_number IN (${placeholders}) AND d.resigned_on IS NULL ORDER BY c.company_name, d.name`,
      cns
    )
    return NextResponse.json({ directors: rows.rows })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
