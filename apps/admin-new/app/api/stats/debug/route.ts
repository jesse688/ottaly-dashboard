import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// GET /api/stats/debug?workspace_id=...&date=YYYY-MM-DD
// Diagnostic: shows the cached perf_cache_daily row vs a LIVE PlusVibe
// email-stats pull for one workspace+date, so reply/OOO mismatches (e.g.
// "0 human replies but a lead") can be pinpointed without DB access.
export async function GET(req: NextRequest) {
  const wsId = req.nextUrl.searchParams.get('workspace_id') || ''
  const date = req.nextUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10)
  if (!wsId) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })

  const out: Record<string, unknown> = { workspace_id: wsId, date }

  // 1. What's cached
  try {
    const { rows } = await pool.query(
      `SELECT data, saved_at FROM perf_cache_daily WHERE ws_id = $1 AND date = $2`,
      [wsId, date],
    )
    out.cached = rows[0]
      ? { ...rows[0].data, saved_at: rows[0].saved_at, saved_ago_min: Math.round((Date.now() - Number(rows[0].saved_at)) / 60000) }
      : null
  } catch (e) {
    out.cachedError = e instanceof Error ? e.message : String(e)
  }

  // 2. Leads counted in-window for this workspace
  try {
    const { rows } = await pool.query(
      `SELECT lead_email, date, label FROM revenue_leads
        WHERE workspace_id = $1 AND pv_nonlead IS NOT TRUE AND date >= $2 AND date <= $2`,
      [wsId, date],
    )
    out.leads_in_window = rows
  } catch (e) {
    out.leadsError = e instanceof Error ? e.message : String(e)
  }

  // 3. Live PlusVibe email-stats for the same date
  try {
    const key = process.env.PLUSVIBE_API_KEY || ''
    if (key) {
      const r = await fetch(
        `https://api.plusvibe.ai/api/v1/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}`,
        { headers: { 'x-api-key': key } },
      )
      const raw = await r.json().catch(() => ({}))
      out.live_pv_header = raw?.header ?? raw
    } else {
      out.live_pv_header = 'PLUSVIBE_API_KEY not set on admin-new'
    }
  } catch (e) {
    out.liveError = e instanceof Error ? e.message : String(e)
  }

  return NextResponse.json(out)
}
