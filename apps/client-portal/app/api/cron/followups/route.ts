import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { draftFollowup, FOLLOWUP_MODEL, LATER_OR_REFERRAL, replyBodyText as bodyText } from '@/lib/followups'

// Follow-ups scanner. Finds human replies that were NOT marked as a lead and
// asks the model whether they carry a later / someone-else action, then stores
// a drafted follow-up for an admin to approve. Idempotent: one followups row per
// source reply (UNIQUE), including 'skipped' rows for replies with no action.
// Auth ?secret=CRON_SECRET. ?days=N look-back (default 3, max 200 for backfill).
// ?limit=N replies per run (default 60). ?budget=ms (default 90s, max 280s).
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 200)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 1), 500)
  const budgetMs = Math.min(Math.max(parseInt(url.searchParams.get('budget') || '90000', 10) || 90000, 5000), 280000)
  const deadline = Date.now() + budgetMs

  // Candidates: human replies, not billed, not already scanned. Positives and
  // questions always; not_interested/other only if they hint at later/someone else
  // (filtered below) so a no doesn't cost a model call.
  const { rows } = await pool.query(
    `SELECT r.id, r.client_id, r.workspace_id, r.subject, r.body_preview, r.raw, r.received_at,
            COALESCE(NULLIF(r.sender_email,''), r.lead_email) AS reply_from, r.lead_email,
            COALESCE(r.admin_label, r.category) AS cat, c.company_name
       FROM unibox_replies r
       LEFT JOIN portal_clients c ON c.id = r.client_id
      WHERE r.received_at > NOW() - ($1 || ' days')::interval
        AND r.classify_state = 'done'
        AND COALESCE(r.admin_label, r.category) IN ('interested','question','other','not_interested')
        AND r.marked_as_lead IS NOT TRUE
        AND r.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.source_reply_id = r.id)
      ORDER BY r.received_at DESC
      LIMIT $2`,
    [String(days), limit * 3]
  )

  const stats = { candidates: rows.length, scanned: 0, created: 0, skipped: 0, prefiltered: 0, errors: 0 }
  for (const r of rows) {
    if (stats.scanned >= limit || Date.now() > deadline) break
    const text = bodyText(r.raw, r.body_preview)
    const own = text.split(/\n(?:On .{5,80}wrote:|-{3,} ?Original Message|From: )/)[0]
    if ((r.cat === 'not_interested' || r.cat === 'other') && !LATER_OR_REFERRAL.test(own)) {
      await pool.query(
        `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, status, status_note)
         VALUES ($1,$2,$3,$4,'none','skipped','prefilter') ON CONFLICT (source_reply_id) DO NOTHING`,
        [r.id, r.client_id, r.workspace_id, r.lead_email]
      )
      stats.prefiltered++
      continue
    }
    stats.scanned++
    try {
      const d = await draftFollowup({
        client: r.company_name ?? 'the client', subject: r.subject ?? '', body: text,
        leadEmail: r.reply_from, receivedAt: new Date(r.received_at),
      })
      const status = d.action_type === 'none' ? 'skipped'
        : d.action_type === 'referral' && !d.target_email ? 'needs_email' : 'new'
      const due = d.action_type === 'recontact_on' && d.due_date ? d.due_date : new Date().toISOString().slice(0, 10)
      await pool.query(
        `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, reason, due_at,
                                target_name, target_email, draft_subject, draft_body, confidence, status, ai_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (source_reply_id) DO NOTHING`,
        [r.id, r.client_id, r.workspace_id, r.reply_from, d.action_type, d.reason, due,
         d.target_name || null, d.target_email || null, d.draft_subject || null, d.draft_body || null,
         d.confidence, status, FOLLOWUP_MODEL]
      )
      if (status === 'skipped') stats.skipped++; else stats.created++
    } catch (err) {
      stats.errors++
      console.error('[followups] draft failed', r.id, String(err).slice(0, 200))
    }
  }
  console.log('[followups] scan', JSON.stringify(stats))
  return NextResponse.json({ ok: true, days, ...stats })
}
