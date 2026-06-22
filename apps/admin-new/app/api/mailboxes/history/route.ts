import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/mailboxes/history?dimension=supplier|type&days=30
// Returns daily trend rows for the mailbox performance charts, grouped by key.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const dimension = searchParams.get('dimension') === 'type' ? 'type' : 'supplier'
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 90)

    const res = await pool.query(
      `SELECT day, key, count, active, total_sent, reply_rate, bounce_rate, warmup_pct
         FROM mailbox_supplier_daily
        WHERE dimension = $1 AND day >= CURRENT_DATE - ($2::int - 1)
        ORDER BY day ASC, key ASC`,
      [dimension, days]
    )

    // Shape into { days: [...], series: { key: { sent[], reply_rate[], bounce_rate[] } } }
    const dayset = Array.from(new Set(res.rows.map(r => new Date(r.day).toISOString().slice(0, 10)))).sort()
    const dayIdx = new Map(dayset.map((d, i) => [d, i]))
    const series: Record<string, { sent: number[]; reply_rate: number[]; bounce_rate: number[] }> = {}
    for (const r of res.rows) {
      const k = r.key as string
      if (!series[k]) series[k] = {
        sent: new Array(dayset.length).fill(0),
        reply_rate: new Array(dayset.length).fill(0),
        bounce_rate: new Array(dayset.length).fill(0),
      }
      const i = dayIdx.get(new Date(r.day).toISOString().slice(0, 10))!
      series[k].sent[i] = r.total_sent ?? 0
      series[k].reply_rate[i] = r.reply_rate != null ? Number(r.reply_rate) : 0
      series[k].bounce_rate[i] = r.bounce_rate != null ? Number(r.bounce_rate) : 0
    }
    return NextResponse.json({ dimension, days: dayset, series })
  } catch (err) {
    console.error('[mailboxes/history]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
