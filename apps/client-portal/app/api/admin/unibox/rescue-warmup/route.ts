import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Rescue replies that were incorrectly classified as warmup by the now-removed
// hyphen-pair heuristic. Bison filters its own warmups; the hyphen-pair rule
// caused false positives on genuine replies like "government-funded".
//
// Only rescues rows where:
//   • category = 'warmup' AND folder = 'warmup'
//   • ai_model = 'prefilter' (our code, not Gemini)
//   • ai_reasoning contains 'word-pair' (the hyphen-pair heuristic, NOT explicit markers)
//   • admin_label IS NULL and marked_as_lead = FALSE (no human has touched it)
//
// Re-queues as pending so the classify cron re-runs them under the new rule.
//
// GET ?secret=CRON_SECRET or admin session → preview (no changes)
// POST ?secret=CRON_SECRET or admin session → apply rescue
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
    // Preview mode: return the rows that would be rescued
    const r = await pool.query(
      `SELECT id, workspace_id, lead_email, subject, body_preview, ai_reasoning, received_at
         FROM unibox_replies
        WHERE category = 'warmup'
          AND folder = 'warmup'
          AND ai_model = 'prefilter'
          AND ai_reasoning LIKE '%word-pair%'
          AND admin_label IS NULL
          AND marked_as_lead = FALSE
        ORDER BY received_at DESC
        LIMIT 500`,
      []
    )
    return NextResponse.json({ ok: true, mode: 'preview', count: r.rowCount ?? 0, rows: r.rows })
  }

  // Apply: re-queue as pending so the classify cron re-runs under the new (no hyphen-pair) rule
  const r = await pool.query(
    `UPDATE unibox_replies
        SET classify_state = 'pending',
            classify_next_at = NULL,
            classify_attempts = 0,
            folder = 'inbox',
            category = NULL,
            ai_model = NULL,
            ai_reasoning = NULL,
            updated_at = NOW()
      WHERE category = 'warmup'
        AND folder = 'warmup'
        AND ai_model = 'prefilter'
        AND ai_reasoning LIKE '%word-pair%'
        AND admin_label IS NULL
        AND marked_as_lead = FALSE
      RETURNING id`,
    []
  )
  return NextResponse.json({ ok: true, mode: 'apply', rescued: r.rowCount ?? 0 })
}
