import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Fix backlog inbox rows:
//   1. category='warmup' + folder='inbox' → move to folder='warmup'
//   2. category='other' + folder='inbox'  → reset to pending so Gemini re-classifies
//
// GET  → preview counts (no changes)
// POST → apply fixes
export async function GET(req: NextRequest) {
  return handle(req, false)
}
export async function POST(req: NextRequest) {
  return handle(req, true)
}

async function handle(req: NextRequest, apply: boolean) {
  const secret = new URL(req.url).searchParams.get('secret')
  const authed = (secret && secret === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  if (!apply) {
    const [warmup, other] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM unibox_replies WHERE category = 'warmup' AND folder != 'warmup'`),
      pool.query(`SELECT COUNT(*) FROM unibox_replies WHERE category = 'other' AND folder IN ('inbox','review') AND classify_state = 'done'`),
    ])
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      warmup_to_move: parseInt(warmup.rows[0].count),
      other_to_reclassify: parseInt(other.rows[0].count),
    })
  }

  const [warmupResult, otherResult] = await Promise.all([
    // Move any warmup-classified row that isn't already in the warmup folder
    pool.query(
      `UPDATE unibox_replies
          SET folder = 'warmup', updated_at = NOW()
        WHERE category = 'warmup' AND folder != 'warmup'
        RETURNING id`
    ),
    // Re-queue 'other' rows in inbox/review for Gemini reclassification
    pool.query(
      `UPDATE unibox_replies
          SET classify_state = 'pending',
              classify_next_at = NULL,
              classify_attempts = 0,
              category = NULL,
              ai_model = NULL,
              ai_reasoning = NULL,
              updated_at = NOW()
        WHERE category = 'other'
          AND folder IN ('inbox', 'review')
          AND classify_state = 'done'
          AND admin_label IS NULL
          AND marked_as_lead = FALSE
        RETURNING id`
    ),
  ])

  return NextResponse.json({
    ok: true,
    mode: 'apply',
    warmup_moved: warmupResult.rowCount ?? 0,
    other_requeued: otherResult.rowCount ?? 0,
  })
}
