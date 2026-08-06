import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const workspaceId = p.get('workspace_id')
  const signalType = p.get('signal_type')
  // Bind as a parameter, never interpolate: parseInt returns NaN for junk input
  // and NaN stringifies into the SQL literal, which is an injection point.
  const parsedHours = Number.parseInt(p.get('hours') ?? '24', 10)
  const hours = Number.isFinite(parsedHours)
    ? Math.min(Math.max(parsedHours, 1), 24 * 365)
    : 24

  const values: unknown[] = [hours]
  const conditions = [`timestamp > now() - make_interval(hours => $1)`]

  if (workspaceId) { values.push(workspaceId); conditions.push(`workspace_id = $${values.length}`) }
  if (signalType) { values.push(signalType); conditions.push(`signal_type = $${values.length}`) }

  try {
    const [signalsRes, factorsRes] = await Promise.all([
      pool.query(
        `SELECT id, timestamp, signal_type, workspace_id, metric_key, metric_value, unit, status, notes
         FROM diagnostic_signals
         WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp DESC
         LIMIT 500`,
        values
      ),
      pool.query(
        `SELECT id, factor_type, description, severity, started_at, ended_at, workspace_id
         FROM diagnostic_external_factors
         ORDER BY started_at DESC
         LIMIT 50`
      ),
    ])
    return NextResponse.json({ signals: signalsRes.rows, factors: factorsRes.rows })
  } catch (err) {
    console.error('[diagnostics]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
