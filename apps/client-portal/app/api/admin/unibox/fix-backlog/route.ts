import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Reconcile the Master Unibox to Bison's automated-reply truth, ONE time.
//
// GOAL: anything Bison tagged as automated (warm-up / OOO / auto-ack) must not
// sit in the working queues (inbox / review / unmapped). Genuine human replies
// stay for AI triage → interested/question → review.
//
// A row is "Bison-automated" if ANY of:
//   • bison_automated_reply = TRUE   (captured at webhook intake)
//   • category = 'ooo_auto_reply' AND ai_model = 'prefilter'  (cron's Bison flag)
//   • category = 'warmup'            (our warm-up detection / AI)
//
// Such rows are moved to the hidden 'warmup' folder — UNLESS they're already with
// the client (folder='replies'), marked as a lead, or human-reviewed (admin_label).
//
// GET  ?secret=CRON_SECRET → diagnostic only (no writes)
// POST ?secret=CRON_SECRET → apply
export async function GET(req: NextRequest) {
  return handle(req, false)
}
export async function POST(req: NextRequest) {
  return handle(req, true)
}

// The set of rows that are Bison-automated AND safe to move out of the queues.
const AUTOMATED_IN_QUEUE = `
  (
    bison_automated_reply = TRUE
    OR (category = 'ooo_auto_reply' AND ai_model = 'prefilter')
    OR category = 'warmup'
  )
  AND folder IN ('inbox', 'review', 'unmapped')
  AND marked_as_lead = FALSE
  AND admin_label IS NULL
`

async function handle(req: NextRequest, apply: boolean) {
  const secret = new URL(req.url).searchParams.get('secret')
  const authed = (secret && secret === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  if (!apply) {
    // Show the real state so we know exactly what POST will do before running it.
    const [byFolder, automatedByFolder, toMove, queueState] = await Promise.all([
      pool.query(`SELECT folder, COUNT(*)::int n FROM unibox_replies GROUP BY folder ORDER BY n DESC`),
      pool.query(
        `SELECT folder, COALESCE(bison_automated_reply::text,'null') AS bison_automated, COUNT(*)::int n
           FROM unibox_replies
          WHERE folder IN ('inbox','review','unmapped')
          GROUP BY folder, bison_automated_reply ORDER BY folder`
      ),
      pool.query(`SELECT COUNT(*)::int n FROM unibox_replies WHERE ${AUTOMATED_IN_QUEUE}`),
      pool.query(
        `SELECT classify_state, COUNT(*)::int n FROM unibox_replies
          WHERE folder = 'inbox' GROUP BY classify_state ORDER BY n DESC`
      ),
    ])
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      automated_to_move: toMove.rows[0].n,
      folder_distribution: byFolder.rows,
      active_folder_automated_split: automatedByFolder.rows,
      inbox_classify_state: queueState.rows,
    })
  }

  const moved = await pool.query(
    `UPDATE unibox_replies
        SET folder = 'warmup', updated_at = NOW()
      WHERE ${AUTOMATED_IN_QUEUE}
      RETURNING id`
  )

  return NextResponse.json({ ok: true, mode: 'apply', automated_moved: moved.rowCount ?? 0 })
}
