import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// One-shot admin tool: re-queue replies that the TIGHTENED warm-up rule would now
// catch but an earlier, looser rule let through to Gemini (which called them
// 'interested'/'other'). Safe by construction — it ONLY re-pends rows that:
//   • are currently done,
//   • have NO human ruling (admin_label IS NULL, marked_as_lead = FALSE),
//   • were NOT already warm-up,
//   • contain a warm-up hyphen-pair signature in the preview, AND
//   • lack STRONG enrichment (no LinkedIn / company website on the matched lead).
// Re-pended rows get re-run by the classify cron under the new rule. Never flips a
// label directly; never touches a human decision or a billed lead.
//
// POST ?secret=CRON_SECRET (or admin session). Returns how many were re-queued.
export async function POST(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  const authed = (secret && secret === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  // A "hyphen-pair" warm-up tell: a lowercase word-hyphen-word token in the body.
  // This is a coarse SQL approximation of the detector's HYPHEN_PAIR — good enough
  // to SELECT candidates; the cron's detectWarmup makes the final call on re-run.
  const r = await pool.query(
    `WITH candidates AS (
       SELECT u.id
         FROM unibox_replies u
         LEFT JOIN LATERAL (
           SELECT raw->>'linkedin_person_url' AS linkedin_url,
                  raw->>'company_website'     AS company_website
             FROM esp_leads e
            WHERE e.workspace_id = u.workspace_id
              AND lower(e.email) = lower(u.lead_email)
            ORDER BY (e.source = 'bison') DESC, e.updated_at DESC
            LIMIT 1
         ) l ON TRUE
        WHERE u.classify_state = 'done'
          AND u.admin_label IS NULL
          AND u.marked_as_lead = FALSE
          AND COALESCE(u.category,'') <> 'warmup'
          AND u.is_forwarded = FALSE
          AND (COALESCE(u.subject,'') || ' ' || COALESCE(u.body_preview,'')) ~ '[a-z]{3,}-[a-z]{3,}'
          AND COALESCE(l.linkedin_url,'') = ''
          AND COALESCE(l.company_website,'') = ''
     )
     UPDATE unibox_replies SET classify_state = 'pending', classify_next_at = NULL, updated_at = NOW()
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id`,
    []
  )
  return NextResponse.json({ ok: true, requeued: r.rowCount ?? 0 })
}
