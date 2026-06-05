import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const [logsRes, patternsRes] = await Promise.all([
      pool.query(
        `SELECT id, workspace_id, date, tier, reply_rate, send_volume,
                narrative, recommendations, computed_at
         FROM daily_intelligence_logs
         ORDER BY date DESC
         LIMIT 100`
      ),
      pool.query(
        `SELECT id, pattern_type, pattern_value, workspace_id,
                avg_reply_rate, avg_bounce_rate, sample_size, correlation_strength, last_updated
         FROM performance_patterns
         ORDER BY correlation_strength DESC NULLS LAST`
      ),
    ])
    return NextResponse.json({ logs: logsRes.rows, patterns: patternsRes.rows })
  } catch (err) {
    console.error('[intelligence]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
