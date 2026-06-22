import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// Read-only view over ottaly_engine_leads — clean B2B leads the autonomous
// data engine promotes into prod. Table grows 24/7, so always paginate.
// Shared helper kept in sync with the export route.
export function buildEngineLeadsFilter(p: URLSearchParams) {
  // source/show are exact-match (drop-down values); the rest are ILIKE.
  const source = (p.get('source') || '').trim() || null
  const show = (p.get('show') || '').trim() || null
  const industry = (p.get('industry') || '').trim() || null
  const region = (p.get('region') || '').trim() || null
  const platform = (p.get('platform') || '').trim() || null
  const search = (p.get('search') || '').trim() || null

  // has_products: 'true' | 'false' | anything-else => no filter (null)
  let hasProducts: boolean | null = null
  if (p.get('has_products') === 'true') hasProducts = true
  if (p.get('has_products') === 'false') hasProducts = false

  const where = `
    WHERE ($1::text IS NULL OR source = $1)
      AND ($2::text IS NULL OR show = $2)
      AND ($3::text IS NULL OR industry ILIKE '%'||$3||'%')
      AND ($4::text IS NULL OR region   ILIKE '%'||$4||'%')
      AND ($5::bool IS NULL OR has_products = $5)
      AND ($6::text IS NULL OR platform ILIKE '%'||$6||'%')
      AND ($7::text IS NULL OR domain ILIKE '%'||$7||'%' OR company_name ILIKE '%'||$7||'%')`

  return { where, params: [source, show, industry, region, hasProducts, platform, search] }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const limit = Math.min(parseInt(p.get('limit') || '50', 10) || 50, 200)
  const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0)

  const { where, params } = buildEngineLeadsFilter(p)

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ottaly_engine_leads ${where}`,
      params
    )
    const total = countRes.rows[0].n

    const { rows } = await pool.query(
      `SELECT * FROM ottaly_engine_leads ${where}
       ORDER BY promoted_at DESC NULLS LAST
       LIMIT $8 OFFSET $9`,
      [...params, limit, offset]
    )

    return NextResponse.json({ total, limit, offset, count: rows.length, leads: rows })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[engine-leads] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
