import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { ensureSchema } from '@/lib/mailbox-health'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * One-off import of mailbox history that PlusVibe can no longer return.
 *
 * WHY THIS EXISTS. Cumulative sends are stitched from 90-day windows because
 * PlusVibe has no lifetime counter and rejects any longer range. That means a
 * day which falls out of its 90-day reach is gone for good — it cannot be
 * re-fetched at any price.
 *
 * The standalone version of this system had been banking those days since
 * 2025-11-20. Postgres started on 2026-09-12. Without this import the burn
 * model is simply wrong: it reports 0 mailboxes past the 350-send threshold
 * where the true figure is 654, because it can only see six days of sending.
 *
 * SELF-AUTHENTICATING, like /api/data/esp-matching/enforce: pass
 * ?key=<ADMIN_KEY>. That avoids moving a write-capable database credential
 * around — the read-only role exists precisely because superuser access once
 * froze the contacts page.
 *
 * IDEMPOTENT. Day rows are ON CONFLICT DO NOTHING: a row already banked is
 * never overwritten, because the stored value came from PlusVibe when the data
 * was still reachable and is therefore the better one. Safe to re-run.
 *
 * Usage:
 *   curl -X POST "https://<host>/api/mailbox-health/import-history?key=$ADMIN_KEY" \
 *        -H 'Content-Type: application/json' --data-binary @mbx-history.json
 */

interface DailyRow {
  email: string; date: string
  sent: number; ooo: number; replies: number
  positive: number; contacted: number; bounce: number
}
interface WindowRow {
  email: string; start_date: string; end_date: string
  sent: number; ooo: number; replies: number; positive: number
  contacted: number; bounce: number
  recipient_bounce: number; sender_bounce: number
}

const CHUNK = 500

export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || ''
  const expected = process.env.ADMIN_KEY || ''
  if (!expected || key !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { daily?: DailyRow[]; windows?: WindowRow[]; cutoff?: string }
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const daily = payload.daily ?? []
  const windows = payload.windows ?? []
  if (!daily.length && !windows.length) {
    return NextResponse.json({ error: 'nothing to import' }, { status: 400 })
  }

  try {
    await ensureSchema()
    const before = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM mbx_daily`)

    // Multi-row inserts in chunks. One statement per row would be ~58,000
    // round trips and would not finish inside the request.
    for (let i = 0; i < daily.length; i += CHUNK) {
      const batch = daily.slice(i, i + CHUNK)
      const values: unknown[] = []
      const tuples = batch.map((r, j) => {
        const b = j * 8
        values.push(r.email, r.date, r.sent, r.ooo, r.replies, r.positive, r.contacted, r.bounce)
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`
      }).join(',')
      await pool.query(
        `INSERT INTO mbx_daily (email, date, sent, ooo, replies, positive, contacted, bounce)
         VALUES ${tuples}
         ON CONFLICT (email, date) DO NOTHING`,
        values,
      )
    }

    for (let i = 0; i < windows.length; i += CHUNK) {
      const batch = windows.slice(i, i + CHUNK)
      const values: unknown[] = []
      const tuples = batch.map((r, j) => {
        const b = j * 11
        values.push(r.email, r.start_date, r.end_date, r.sent, r.ooo, r.replies,
          r.positive, r.contacted, r.bounce, r.recipient_bounce, r.sender_bounce)
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`
      }).join(',')
      await pool.query(
        `INSERT INTO mbx_window (email, start_date, end_date, sent, ooo, replies,
           positive, contacted, bounce, recipient_bounce, sender_bounce)
         VALUES ${tuples}
         ON CONFLICT (email, start_date, end_date) DO NOTHING`,
        values,
      )
    }

    const after = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM mbx_daily`)
    const oldest = await pool.query<{ d: string | null }>(`SELECT MIN(date)::text AS d FROM mbx_daily`)
    // The number that says whether this worked: the burn model needs lifetime
    // sends, and lifetime sends need the history.
    const past = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT email FROM mbx_daily GROUP BY email HAVING SUM(sent) >= 350) x`,
    )

    return NextResponse.json({
      ok: true,
      offered: { daily: daily.length, windows: windows.length },
      day_rows_before: Number(before.rows[0].n),
      day_rows_after: Number(after.rows[0].n),
      added: Number(after.rows[0].n) - Number(before.rows[0].n),
      oldest_day: oldest.rows[0].d,
      mailboxes_past_threshold: Number(past.rows[0].n),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:import-history' } })
    const msg = err instanceof Error ? err.message : 'import failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
