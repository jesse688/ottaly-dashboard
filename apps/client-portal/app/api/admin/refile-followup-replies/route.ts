import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// One-off: move follow-up replies OUT of Review into the new 'replies' folder. A
// follow-up = a reply (not itself marked) whose lead was ALREADY marked as a lead by an
// earlier reply (same workspace + lead_email). These are replies to the CLIENT and
// shouldn't clutter Review. Idempotent. Admin session OR ?secret=CRON_SECRET.
//   /api/admin/refile-followup-replies            → DRY RUN (count)
//   /api/admin/refile-followup-replies?apply=1    → move them
export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

async function run(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const okSecret = !!secret && !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!okSecret && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized — log into /admin, or append ?secret=CRON_SECRET' }, { status: 401 })
  }
  await ready()
  const apply = url.searchParams.get('apply') === '1'

  // Rows in review that are NOT marked themselves, but whose lead is already marked.
  const where = `
    u.folder = 'review' AND u.marked_as_lead = FALSE
    AND EXISTS (
      SELECT 1 FROM unibox_replies m
       WHERE m.workspace_id = u.workspace_id
         AND lower(m.lead_email) = lower(u.lead_email)
         AND m.marked_as_lead = TRUE AND m.id <> u.id
    )`

  const preview = await pool.query(`SELECT count(*)::int AS n FROM unibox_replies u WHERE ${where}`)
    .catch((e) => ({ rows: [{ n: -1, error: String(e) }] }))

  let moved = 0
  if (apply) {
    const r = await pool.query(
      `UPDATE unibox_replies u SET folder = 'replies', updated_at = NOW() WHERE ${where}`
    ).catch(() => null)
    moved = r?.rowCount ?? 0
  }

  return NextResponse.json({
    ok: true, applied: apply, wouldMove: preview.rows[0]?.n ?? 0, moved,
    note: apply ? 'Moved to the Replies folder.' : 'DRY RUN — add ?apply=1 to move.',
  })
}
