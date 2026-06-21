import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Per-workspace frozen revenue rollup (real leads only — non-leads excluded).
// Mirrors legacy /api/revenue/stats-by-workspace, sourced from revenue_leads.

interface Row {
  workspace_id: string
  workspace_name: string
  delivered: string
  revenue: string
}

export async function GET() {
  try {
    const res = await pool.query<Row>(
      `SELECT workspace_id,
              MAX(workspace_name)           AS workspace_name,
              COUNT(*)                      AS delivered,
              COALESCE(SUM(lead_price), 0)  AS revenue
         FROM revenue_leads
        WHERE pv_nonlead IS NOT TRUE
          AND UPPER(COALESCE(label, '')) NOT IN ('NON_LEAD', 'NONLEAD', 'NON LEAD')
        GROUP BY workspace_id
        ORDER BY revenue DESC`,
    )
    const out: Record<string, { name: string; delivered: number; revenue: number }> = {}
    for (const r of res.rows) {
      out[r.workspace_id] = {
        name: r.workspace_name || r.workspace_id,
        delivered: Number(r.delivered),
        revenue: Number(r.revenue),
      }
    }
    return NextResponse.json(out)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/revenue/stats-by-workspace] query failed:', message)
    return NextResponse.json(
      { error: `stats-by-workspace query failed: ${message}` },
      { status: 500 },
    )
  }
}
