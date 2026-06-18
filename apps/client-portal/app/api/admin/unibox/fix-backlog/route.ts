import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Reconcile the Master Unibox to Bison's automated-reply truth, ONE time.
//
// The rule, end to end: rely on BISON's automated flag to hide replies. Our own
// warm-up tagging must never permanently bury a reply — anything we (not Bison)
// called warm-up gets handed back to the AI to judge for interest.
//
// TWO disjoint sets:
//
//   HIDE (→ 'warmup' folder, no AI) — Bison CONFIRMED it's automated:
//     • bison_automated_reply = TRUE          (captured at webhook intake)
//     • category='ooo_auto_reply' AND ai_model='prefilter'  (cron's Bison flag)
//
//   REQUEUE (→ pending, AI re-classifies) — WE tagged it warm-up, Bison did not:
//     • category='warmup' AND bison_automated_reply IS NOT TRUE
//       (old PlusVibe-era / heuristic warm-ups — may be genuine leads)
//
// When requeued, the classify cron's remaining repeated-word-token check
// re-buries true Bison token warm-ups, while old PV/hyphen ones (which no longer
// match any detector) flow to the AI → interested/question → review.
//
// Both sets skip rows already with the client (folder='replies'), marked as a
// lead, or human-reviewed (admin_label).
//
// GET  ?secret=CRON_SECRET → diagnostic only (no writes)
// POST ?secret=CRON_SECRET → apply
export async function GET(req: NextRequest) {
  return handle(req, false)
}
export async function POST(req: NextRequest) {
  return handle(req, true)
}

const SAFE = `
  marked_as_lead = FALSE
  AND admin_label IS NULL
  AND folder <> 'replies'
`

// Bison-confirmed automated, sitting in a working queue → hide.
const HIDE = `
  (
    bison_automated_reply = TRUE
    OR (category = 'ooo_auto_reply' AND ai_model = 'prefilter')
  )
  AND folder IN ('inbox', 'review', 'unmapped')
  AND ${SAFE}
`

// Warm-up WE tagged that Bison did not confirm → hand back to the AI.
const REQUEUE = `
  category = 'warmup'
  AND bison_automated_reply IS NOT TRUE
  AND folder IN ('inbox', 'review', 'unmapped', 'warmup')
  AND ${SAFE}
`

async function handle(req: NextRequest, apply: boolean) {
  const secret = new URL(req.url).searchParams.get('secret')
  const authed = (secret && secret === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  if (!apply) {
    const [byFolder, toHide, toRequeue, warmupComposition] = await Promise.all([
      pool.query(`SELECT folder, COUNT(*)::int n FROM unibox_replies GROUP BY folder ORDER BY n DESC`),
      pool.query(`SELECT COUNT(*)::int n FROM unibox_replies WHERE ${HIDE}`),
      pool.query(`SELECT COUNT(*)::int n FROM unibox_replies WHERE ${REQUEUE}`),
      // What's actually in the warm-up category, split by Bison confirmation +
      // the reasoning that tagged it — so we can SEE the PV-vs-Bison breakdown.
      pool.query(
        `SELECT COALESCE(bison_automated_reply::text,'null') AS bison_confirmed,
                COALESCE(ai_model,'?') AS tagged_by,
                COALESCE(LEFT(ai_reasoning,40),'?') AS reason,
                COUNT(*)::int n
           FROM unibox_replies
          WHERE category = 'warmup'
          GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25`
      ),
    ])
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      automated_to_hide: toHide.rows[0].n,
      warmups_to_requeue_for_ai: toRequeue.rows[0].n,
      folder_distribution: byFolder.rows,
      warmup_category_composition: warmupComposition.rows,
    })
  }

  // Default action = HIDE only: remove everything Bison tagged as automated from
  // the working queues. The PV-era warm-up re-queue (Gemini rescue) is opt-in via
  // ?mode=full, since Gemini over-calls those as interested.
  const mode = new URL(req.url).searchParams.get('mode') ?? 'hide'

  const hidden = await pool.query(
    `UPDATE unibox_replies SET folder = 'warmup', updated_at = NOW()
      WHERE ${HIDE} RETURNING id`
  )

  let requeued = { rowCount: 0 } as { rowCount: number | null }
  if (mode === 'full') {
    requeued = await pool.query(
      `UPDATE unibox_replies
          SET classify_state = 'pending', classify_next_at = NULL, classify_attempts = 0,
              folder = 'inbox', category = NULL, ai_model = NULL, ai_reasoning = NULL,
              updated_at = NOW()
        WHERE ${REQUEUE} RETURNING id`
    )
  }

  return NextResponse.json({
    ok: true,
    mode: mode === 'full' ? 'apply-full' : 'apply-hide-only',
    automated_hidden: hidden.rowCount ?? 0,
    warmups_requeued_for_ai: requeued.rowCount ?? 0,
  })
}
