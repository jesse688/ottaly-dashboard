import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const res = await pool.query(
      `SELECT workspace_id, workspace_name, lead_email, first_name, last_name,
              campaign, lead_price, date, label, pv_nonlead, updated_at
       FROM revenue_leads
       WHERE pv_nonlead IS NOT TRUE
       ORDER BY date DESC`
    )
    const rows = res.rows
    const byWorkspace: Record<string, { name: string; leads: number; revenue: number }> = {}
    for (const r of rows) {
      if (!byWorkspace[r.workspace_id]) {
        byWorkspace[r.workspace_id] = { name: r.workspace_name, leads: 0, revenue: 0 }
      }
      byWorkspace[r.workspace_id].leads++
      byWorkspace[r.workspace_id].revenue += parseFloat(r.lead_price ?? 0)
    }
    return NextResponse.json({ leads: rows, summary: Object.entries(byWorkspace).map(([id, v]) => ({ workspace_id: id, ...v })) })
  } catch (err) {
    console.error('[revenue]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
