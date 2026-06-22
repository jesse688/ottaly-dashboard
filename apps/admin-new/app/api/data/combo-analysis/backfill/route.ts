import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// ── Webhook backfill ────────────────────────────────────────────────────────
// DB-direct port of legacy POST /api/combo-analysis/backfill. Extracts the
// sender_email out of the stored webhook payload (email_events.raw) for any
// non-seeded rows that don't have it populated yet, improving sender-data
// coverage. Pure SQL — no stateful job — so it runs directly here.

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    // Diagnostics: which keys exist in raw + one sample (mirrors legacy response)
    const [keysRes, sampleRes] = await Promise.all([
      pool.query(
        `SELECT key, COUNT(*)::int AS n
         FROM email_events, jsonb_object_keys(raw) AS key
         WHERE raw IS NOT NULL AND raw::text <> 'null'
         GROUP BY key ORDER BY n DESC LIMIT 30`
      ),
      pool.query(
        `SELECT raw FROM email_events
         WHERE raw IS NOT NULL AND raw::text <> 'null'
         LIMIT 1`
      ),
    ])

    const { rowCount } = await pool.query(
      `UPDATE email_events
       SET sender_email = LOWER(raw->>'sender_email')
       WHERE sender_email IS NULL
         AND raw IS NOT NULL
         AND raw::text <> 'null'
         AND raw->>'sender_email' IS NOT NULL
         AND (raw->>'seeded')::boolean IS NOT TRUE`
    )

    return NextResponse.json({
      ok: true,
      updated: rowCount,
      raw_keys: keysRes.rows,
      sample_raw: sampleRes.rows[0]?.raw ?? null,
    })
  } catch (err) {
    console.error('[combo-analysis/backfill]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 }
    )
  }
}
