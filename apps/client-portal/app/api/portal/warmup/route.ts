import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET — the client's email-warmup progress, for the top-of-portal bar.
// Returns null/active=false when no start date is set (bar hidden) or warmup is
// already complete.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const r = await pool.query(
    `SELECT warmup_start_date, warmup_days FROM portal_clients WHERE id = $1`,
    [session.clientId]
  )
  const row = r.rows[0]
  if (!row?.warmup_start_date) return NextResponse.json({ active: false })

  const days = Math.max(1, Number(row.warmup_days) || 14)
  const start = new Date(row.warmup_start_date)
  start.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const msPerDay = 86400000
  const elapsed = Math.floor((today.getTime() - start.getTime()) / msPerDay)
  const end = new Date(start.getTime() + days * msPerDay)

  if (elapsed < 0) return NextResponse.json({ active: false })

  // Phase model — we know when WARMUP finishes, but NOT when the first lead
  // lands, so we never promise a lead date. After warmup we show a short
  // "campaign live, leads shortly" state, then hide the bar.
  if (elapsed >= days) {
    const sinceDone = elapsed - days
    if (sinceDone <= 3) {
      return NextResponse.json({ active: true, phase: 'live', totalDays: days, pct: 100 })
    }
    return NextResponse.json({ active: false, complete: true })
  }

  const daysLeft = days - elapsed
  const pct = Math.min(99, Math.round((elapsed / days) * 100))
  void end
  return NextResponse.json({
    active: true,
    phase: 'warming',
    dayCurrent: elapsed + 1,   // "Day 3 of 14"
    totalDays: days,
    daysLeft,
    pct,
  })
}
