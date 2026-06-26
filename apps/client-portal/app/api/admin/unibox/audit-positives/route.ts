import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { CLASSIFIER_VERSION } from '@/lib/classify'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// POST /api/admin/unibox/audit-positives  (?all=1)
// Safety-net audit: a misclassified POSITIVE could only hide in the AI-decided
// negative folders — not_interested and OOO. This re-queues those rows for the
// classify worker to re-judge; defaultFolderForCategory then lifts anything that
// comes back interested/question into Review. So even a classifier error
// self-corrects on the next audit.
//
// Deliberately NEVER touches:
//   • admin decisions — admin_label set, or marked_as_lead (human already ruled)
//   • the 'done' folder — admin REJECTS live there; re-judging would undo them
//   • warm-up — tag-based + deterministic, a real reply can't be mis-filed there
//
// By default only re-judges rows NOT already on the current CLASSIFIER_VERSION
// (cheap — after one pass it no-ops until the logic changes). ?all=1 forces a
// full re-judge (use to catch model drift). Run the classify cron after to drain.
export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const ok = (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) || !!await getAdminSession()
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const all = url.searchParams.get('all') === '1'
  try {
    const r = await pool.query(
      `UPDATE unibox_replies
          SET classify_state = 'pending', classify_next_at = NOW(),
              classify_attempts = 0, updated_at = NOW()
        WHERE folder IN ('not_interested', 'ooo')
          AND marked_as_lead = FALSE
          AND admin_label IS NULL
          AND ($1::boolean OR classifier_version IS DISTINCT FROM $2)`,
      [all, CLASSIFIER_VERSION]
    )
    return NextResponse.json({
      ok: true,
      requeued: r.rowCount,
      hint: 'run /api/cron/classify to drain — any positives will move to Review',
    })
  } catch (err) {
    console.error('[audit-positives]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Also accept GET — cron-job.org defaults to GET, and a POST-only route returned
// 405 "HTTP error" on every scheduled run. The action is an idempotent requeue,
// so GET is safe here (still secret-authed inside POST).
export async function GET(req: NextRequest) {
  return POST(req)
}
