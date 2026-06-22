import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// GET /api/data/engine-leads/distinct-values?field=industry
// Populates the engine-leads filter dropdowns from real values in
// ottaly_engine_leads, with counts, ordered by frequency.
const ALLOWED: Record<string, string> = {
  industry: 'industry',
  region: 'region',
  platform: 'platform',
  source: 'source',
  show: 'show',
  company_size: 'company_size',
}

export async function GET(req: NextRequest) {
  const field = req.nextUrl.searchParams.get('field') || ''
  const col = ALLOWED[field]
  if (!col) {
    return NextResponse.json({ error: 'invalid field' }, { status: 400 })
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${col} AS value, COUNT(*)::int AS count
         FROM ottaly_engine_leads
        WHERE ${col} IS NOT NULL AND ${col}::text <> ''
        GROUP BY ${col}
        ORDER BY count DESC, ${col}
        LIMIT 500`,
    )
    return NextResponse.json({
      field,
      values: rows.map((r) => ({ value: String(r.value), count: r.count })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[engine-leads/distinct-values] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
