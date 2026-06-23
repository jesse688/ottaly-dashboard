import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/mailboxes/history?dimension=supplier|type&days=30
// Per-group daily series for the provider/supplier performance cards. Returns
// raw daily counts so the cards can show SENT, human RR (replies/contacted),
// RR+OOO ((replies+ooo)/contacted), and bounce rate — and a toggleable
// multi-line chart. NOTE: total_replies is PV's total_reply_count, which is
// ALREADY the human/non-OOO count; total_ooo is a SEPARATE additive bucket.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const dimension = searchParams.get('dimension') === 'type' ? 'type' : 'supplier'
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 90)

    const res = await pool.query(
      `SELECT day, key, total_sent, total_replies, total_ooo, total_bounces, total_contacted
         FROM mailbox_supplier_daily
        WHERE dimension = $1 AND day >= CURRENT_DATE - ($2::int - 1)
        ORDER BY day ASC, key ASC`,
      [dimension, days]
    )

    const dayset = Array.from(new Set(res.rows.map(r => new Date(r.day).toISOString().slice(0, 10)))).sort()
    const dayIdx = new Map(dayset.map((d, i) => [d, i]))
    const z = () => new Array(dayset.length).fill(0)
    // Per key: daily arrays for each metric.
    const series: Record<string, { sent: number[]; replies: number[]; ooo: number[]; bounces: number[]; contacted: number[] }> = {}
    for (const r of res.rows) {
      const k = r.key as string
      if (!series[k]) series[k] = { sent: z(), replies: z(), ooo: z(), bounces: z(), contacted: z() }
      const i = dayIdx.get(new Date(r.day).toISOString().slice(0, 10))!
      series[k].sent[i] = r.total_sent ?? 0
      series[k].replies[i] = r.total_replies ?? 0
      series[k].ooo[i] = r.total_ooo ?? 0
      series[k].bounces[i] = r.total_bounces ?? 0
      series[k].contacted[i] = r.total_contacted ?? 0
    }
    return NextResponse.json({ dimension, days: dayset, series })
  } catch (err) {
    console.error('[mailboxes/history]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
