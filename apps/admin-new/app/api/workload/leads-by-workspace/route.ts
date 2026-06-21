import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// All-time leads delivered per workspace, from the frozen revenue_leads store
// (pv_nonlead excluded). Used to compute each manager's all-time delivered total
// vs monthly target. date is TEXT so no cast needed here (all-time).
export async function GET() {
  try {
    const res = await pool.query<{ workspace_id: string; leads: string }>(
      `SELECT workspace_id, COUNT(*)::int AS leads
         FROM revenue_leads
        WHERE COALESCE(pv_nonlead, false) = false
        GROUP BY workspace_id`,
    )
    const map: Record<string, number> = {}
    for (const r of res.rows) map[r.workspace_id] = Number(r.leads)
    return NextResponse.json({ leadsByWorkspace: map })
  } catch (err) {
    console.error('[workload/leads-by-workspace]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 },
    )
  }
}
