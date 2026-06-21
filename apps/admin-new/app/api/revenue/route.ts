import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Frozen pay-per-lead revenue. Source of truth = revenue_leads (Postgres).
// NEVER fetched live — mirrors legacy /api/revenue/leads (frozen storage).
// Returns ALL rows (real leads + non-leads) with an is_nonlead flag so the
// UI can show, exclude, or break them out — matching legacy behaviour.

interface RevenueRow {
  workspace_id: string
  workspace_name: string
  client_name: string
  lead_email: string
  first_name: string
  last_name: string
  campaign: string
  lead_price: string | number
  date: string
  label: string
  pv_nonlead: boolean
  updated_at: string | null
}

const NON_LEAD_LABELS = new Set(['NON_LEAD', 'NONLEAD', 'NON LEAD'])

export async function GET() {
  try {
    const res = await pool.query<RevenueRow>(
      `SELECT workspace_id, workspace_name, client_name, lead_email,
              first_name, last_name, campaign, lead_price,
              date, label, pv_nonlead, updated_at
         FROM revenue_leads
        ORDER BY date DESC`,
    )

    const leads = res.rows.map((r) => {
      const labelUp = (r.label || '').toUpperCase()
      const isNonLead = Boolean(r.pv_nonlead) || NON_LEAD_LABELS.has(labelUp)
      return {
        workspace_id: r.workspace_id,
        workspace_name: r.workspace_name || r.client_name || r.workspace_id,
        lead_email: r.lead_email || '',
        first_name: r.first_name || '',
        last_name: r.last_name || '',
        campaign: r.campaign || '',
        lead_price: r.lead_price,
        date: r.date || '',
        label: r.label || '',
        is_nonlead: isNonLead,
        updated_at: r.updated_at,
      }
    })

    return NextResponse.json({ leads, period: 'all-time' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/revenue] query failed:', message)
    return NextResponse.json(
      { error: `revenue_leads query failed: ${message}` },
      { status: 500 },
    )
  }
}
