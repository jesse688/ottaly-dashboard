import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { draftFollowup, FOLLOWUP_MODEL, LATER_OR_REFERRAL, replyBodyText as bodyText, getThreadState, HANDLED_LABELS, FOLLOWUP_LABELS, BILLED_SQL } from '@/lib/followups'

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

  // 1) Re-check open follow-ups: anything that has since become billable, been
  //    labelled as handled in PlusVibe, or been replied to by us drops out.
  const recheck = { billed: 0, handled: 0, replied: 0 }
  const billedNow = await pool.query(
    `UPDATE followups f SET status = 'skipped', status_note = 'billable / marked as lead', updated_at = NOW()
       FROM unibox_replies r
      WHERE r.id = f.source_reply_id AND f.status IN ('new','needs_email') AND ${BILLED_SQL('r')}`
  )
  recheck.billed = billedNow.rowCount ?? 0
  const open = await pool.query(
    `SELECT f.id, f.lead_email, r.workspace_id, r.raw->>'thread_id' AS thread_id, r.received_at
       FROM followups f JOIN unibox_replies r ON r.id = f.source_reply_id
      WHERE f.status IN ('new','needs_email')
        AND COALESCE(r.label_type,'') <> 'fw'   -- Jamie chose FW by hand; don't second-guess it
      ORDER BY f.updated_at ASC LIMIT 10`
  )
  // PlusVibe rate-limits hard (Cloudflare 429) and pv-reconcile shares the same
  // key, so keep live thread checks few, spaced, and stop the moment we're throttled.
  let pvThrottled = false
  for (const o of open.rows) {
    if (pvThrottled || Date.now() > deadline - budgetMs / 2) break
    await new Promise(res => setTimeout(res, 1500))
    const t = await getThreadState(o.workspace_id, o.lead_email, o.thread_id)
    if (t?.rateLimited) { pvThrottled = true; break }
    if (!t) continue
    const note = t.label && HANDLED_LABELS.has(t.label.toUpperCase()) ? `labelled ${t.label} in PlusVibe`
      : t.latestType === 'sent' && t.latestAt && new Date(t.latestAt) > new Date(o.received_at) ? 'we already replied in PlusVibe' : null
    if (note) {
      await pool.query(`UPDATE followups SET status = 'skipped', status_note = $2, updated_at = NOW() WHERE id = $1`, [o.id, note])
      if (note.startsWith('labelled')) recheck.handled++; else recheck.replied++
    } else {
      await pool.query(`UPDATE followups SET updated_at = NOW() WHERE id = $1`, [o.id])
    }
  }

  // 2) Auto-scan is OFF by default: cards only come from Jamie clicking
  //    "Mark as FW" in the Unibox. ?auto=1 runs the old automatic scan by hand.
  const auto = url.searchParams.get('auto') === '1'
  const c = { candidates: 0, scanned: 0, created: 0, skipped: 0, prefiltered: 0, handled: 0, errors: 0 }
  if (auto) {
    // 2) New candidates: human replies that are NOT billable and either
    //    - were not marked as a lead within a day of arriving, or
    //    - carry a follow-up label (e.g. FW) in PlusVibe (any age).
    //    Positives and questions always; not_interested/other only if they hint at
    //    later / someone else (filtered below) so a no doesn't cost a model call.
    const fwLabels = [...FOLLOWUP_LABELS]
    const { rows } = await pool.query(
      `SELECT r.id, r.client_id, r.workspace_id, r.subject, r.body_preview, r.raw, r.received_at,
              COALESCE(NULLIF(r.sender_email,''), r.lead_email) AS reply_from, r.lead_email,
              COALESCE(r.admin_label, r.category) AS cat, c.company_name,
              upper(COALESCE(r.raw->>'label','')) AS pv_label, r.raw->>'thread_id' AS thread_id
         FROM unibox_replies r
         LEFT JOIN portal_clients c ON c.id = r.client_id
        WHERE r.received_at > NOW() - ($1 || ' days')::interval
          AND (r.received_at < NOW() - INTERVAL '1 day' OR upper(COALESCE(r.raw->>'label','')) = ANY($3))
          AND r.classify_state = 'done'
          AND COALESCE(r.admin_label, r.category) IN ('interested','question','other','not_interested')
          AND NOT ${BILLED_SQL('r')}
          AND r.client_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.source_reply_id = r.id)
        ORDER BY r.received_at DESC
        LIMIT $2`,
      [String(days), limit * 3, fwLabels]
    )

    c.candidates = rows.length
    for (const r of rows) {
      if (c.scanned >= limit || Date.now() > deadline) break
      const isFw = FOLLOWUP_LABELS.has(r.pv_label)
      if (HANDLED_LABELS.has(r.pv_label)) {
        await pool.query(
          `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, status, status_note)
           VALUES ($1,$2,$3,$4,'none','skipped',$5) ON CONFLICT (source_reply_id) DO NOTHING`,
          [r.id, r.client_id, r.workspace_id, r.lead_email, `labelled ${r.pv_label} in PlusVibe`]
        )
        c.handled++
        continue
      }
      const text = bodyText(r.raw, r.body_preview)
      const own = text.split(/\n(?:On .{5,80}wrote:|-{3,} ?Original Message|From: )/)[0]
      if (!isFw && (r.cat === 'not_interested' || r.cat === 'other') && !LATER_OR_REFERRAL.test(own)) {
        await pool.query(
          `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, status, status_note)
           VALUES ($1,$2,$3,$4,'none','skipped','prefilter') ON CONFLICT (source_reply_id) DO NOTHING`,
          [r.id, r.client_id, r.workspace_id, r.lead_email]
        )
        c.prefiltered++
        continue
      }
      c.scanned++
      try {
        const d = await draftFollowup({
          client: r.company_name ?? 'the client', subject: r.subject ?? '', body: text,
          leadEmail: r.reply_from, receivedAt: new Date(r.received_at),
        })
        let status = d.action_type === 'none' ? 'skipped'
          : d.action_type === 'referral' && !d.target_email ? 'needs_email' : 'new'
        let note: string | null = null
        // Only replies that would become a card get the (rate-limited) live check:
        // if we already answered in PlusVibe after this reply, or it's labelled as
        // handled, it's being worked, so no card. Unknown (throttled) = keep the card;
        // the next run's re-check will drop it if needed.
        if (status !== 'skipped' && !isFw && !pvThrottled) {
          await new Promise(res => setTimeout(res, 1500))
          const t = await getThreadState(r.workspace_id, r.reply_from, r.thread_id)
          if (t?.rateLimited) pvThrottled = true
          else if (t && ((t.label && HANDLED_LABELS.has(t.label.toUpperCase())) ||
              (t.latestType === 'sent' && t.latestAt && new Date(t.latestAt) > new Date(r.received_at)))) {
            status = 'skipped'; note = t.latestType === 'sent' ? 'we already replied in PlusVibe' : `labelled ${t.label} in PlusVibe`
            c.handled++
          }
        }
        const due = d.action_type === 'recontact_on' && d.due_date ? d.due_date : new Date().toISOString().slice(0, 10)
        await pool.query(
          `INSERT INTO followups (source_reply_id, client_id, workspace_id, lead_email, action_type, reason, due_at,
                                  target_name, target_email, draft_subject, draft_body, confidence, status, ai_model, status_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (source_reply_id) DO NOTHING`,
          [r.id, r.client_id, r.workspace_id, r.reply_from, d.action_type, d.reason, due,
           d.target_name || null, d.target_email || null, d.draft_subject || null, d.draft_body || null,
           d.confidence, status, FOLLOWUP_MODEL, note]
        )
        if (status === 'skipped') { if (!note) c.skipped++ } else c.created++
      } catch (err) {
        c.errors++
        console.error('[followups] draft failed', r.id, String(err).slice(0, 200))
      }
    }
  }
  const stats = { pvThrottled, auto, recheck, ...c }
  console.log('[followups] scan', JSON.stringify(stats))
  return NextResponse.json({ ok: true, days, ...stats })
}
