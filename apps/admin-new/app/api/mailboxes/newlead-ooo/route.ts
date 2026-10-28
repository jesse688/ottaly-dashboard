import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DIMENSIONS, keyFor, asOf, type Dimension, type DimMailbox } from '@/lib/mailbox-dimensions'
import { loadMailboxMoves } from '@/lib/mailbox-moves'

export const dynamic = 'force-dynamic'

// GET /api/mailboxes/newlead-ooo?days=30
//
// OOOs that answered email 1, per card (supplier / type / tag), attributed to
// the mailbox that sent the email. The card divides by its own new-lead count
// (mailbox_supplier_daily.total_new_leads) to get New-lead OOO. The step comes
// from lib/ooo-steps.ts; `total` vs `resolved` lets a card say it is still
// filling rather than show a rate that reads low.
//
// Same OOO definition as Stats: PV labels OUT_OF_OFFICE + AUTOMATIC_REPLY,
// counted once per PlusVibe email id (unibox_replies has two writers).
type Counts = { step1: number; resolved: number; total: number }

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 90)

    const res = await pool.query(
      `WITH ooo AS (
         SELECT DISTINCT ON (u.raw->>'id')
                u.raw->>'id' AS id,
                lower(u.raw->>'eaccount') AS eaccount,
                to_char((COALESCE((u.raw->>'timestamp_created')::timestamptz, u.received_at)
                          AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS day
           FROM unibox_replies u
          WHERE u.raw->>'label' IN ('OUT_OF_OFFICE', 'AUTOMATIC_REPLY')
            AND u.raw->>'id' IS NOT NULL
            AND u.received_at >= CURRENT_DATE - ($1::int + 1)
          ORDER BY u.raw->>'id'
       )
       SELECT o.day, mf.email, mf.supplier, mf.type, mf.tags,
              (s.pv_email_id IS NOT NULL AND s.state <> 'error') AS resolved,
              (s.step = 1) AS step1
         FROM ooo o
         JOIN mailbox_full mf ON lower(mf.email) = o.eaccount
         LEFT JOIN ooo_reply_steps s ON s.pv_email_id = o.id
        WHERE o.day::date >= CURRENT_DATE - ($1::int - 1)`,
      [days],
    )

    const by: Record<Dimension, Record<string, Counts>> = Object.fromEntries(
      DIMENSIONS.map(d => [d, {}]),
    ) as Record<Dimension, Record<string, Counts>>
    const moves = await loadMailboxMoves()
    for (const r of res.rows) {
      const base: DimMailbox = {
        email: (r.email as string) || '',
        type: r.type as string | null,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : null,
        supplier: r.supplier as string | null,
      }
      // Bucket as the mailbox was on that day, like the sends it is divided by.
      const m = asOf(base, r.day as string, moves.get(base.email.toLowerCase()))
      for (const dim of DIMENSIONS) {
        const key = keyFor(dim, m)
        if (!key) continue
        const c = (by[dim][key] ??= { step1: 0, resolved: 0, total: 0 })
        c.total++
        if (r.resolved) c.resolved++
        if (r.step1) c.step1++
      }
    }
    return NextResponse.json({ days, by })
  } catch (err) {
    // ooo_reply_steps is created by the resolver; before its first pass the
    // join fails. The cards show "—" either way.
    console.error('[mailboxes/newlead-ooo]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
