import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { classifyReply, CLASSIFIER_MODEL } from '@/lib/classify'
import { addToBlocklist, unsubscribeLead, bisonTeamForWorkspace } from '@/lib/bison'
import { sendEmail } from '@/lib/email'

// Who gets the internal "new interested reply" alert when one lands in Review.
const INTERESTED_ALERT_TO = process.env.INTERESTED_ALERT_EMAIL || 'jamie@ottaly.co.uk'

// Triage worker for the Master Unibox. Claims a batch of pending replies with
// FOR UPDATE SKIP LOCKED (safe to run concurrently / overlapping), pre-filters
// automated replies for free, and calls Claude on the rest. Authed by
// ?secret=CRON_SECRET like the other crons.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ready()

  const summary = { processed: 0, interested: 0, failed: 0, unsubscribed: 0 }
  // Unsubscribe actions to run AFTER commit (network + stateful Bison switch).
  const unsubQueue: { workspaceId: string; email: string }[] = []
  // Interested-reply alert emails to send AFTER commit.
  const alertQueue: { email: string; subject: string | null; company: string | null }[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Claim up to 50 due pending rows; SKIP LOCKED lets parallel runs not collide.
    const claimed = await client.query(
      `SELECT u.id, u.subject, u.body_preview, u.raw, u.workspace_id, u.lead_email, u.bison_team_id,
              c.company_name
         FROM unibox_replies u
         LEFT JOIN portal_clients c ON c.workspace_id = u.workspace_id
        WHERE u.classify_state = 'pending'
          AND (u.classify_next_at IS NULL OR u.classify_next_at <= NOW())
        ORDER BY u.received_at ASC
        LIMIT 50
        FOR UPDATE OF u SKIP LOCKED`
    )

    for (const row of claimed.rows) {
      const id = row.id as string
      const raw = (row.raw ?? {}) as Record<string, unknown>
      // Free pre-filter: Bison flags out-of-office / auto-acks as automated_reply.
      const replyObj = (raw.reply ?? {}) as Record<string, unknown>
      const automated =
        raw.automated_reply === true || raw.automated_reply === 'true' ||
        replyObj.automated_reply === true || replyObj.automated_reply === 'true'

      if (automated) {
        await client.query(
          `UPDATE unibox_replies
              SET category = 'ooo_auto_reply', classify_state = 'done',
                  ai_model = 'prefilter', ai_reasoning = 'Bison automated_reply flag',
                  updated_at = NOW()
            WHERE id = $1`,
          [id]
        )
        summary.processed++
        continue
      }

      try {
        const result = await classifyReply({
          subject: (row.subject as string) ?? '',
          bodyText: (row.body_preview as string) ?? '',
        })
        // interested → Review for manual decision; unsubscribe → auto-actioned
        // and filed under 'rejected' (no human step needed).
        const folder = result.category === 'interested' ? 'review'
                     : result.category === 'unsubscribe' ? 'rejected'
                     : undefined
        await client.query(
          `UPDATE unibox_replies
              SET category = $2, confidence = $3, ai_model = $4, ai_reasoning = $5,
                  classify_state = 'done',
                  folder = CASE WHEN $6::text IS NOT NULL AND folder IN ('inbox','review') THEN $6 ELSE folder END,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, result.category, result.confidence, CLASSIFIER_MODEL,
           result.reasoning, folder ?? null]
        )
        summary.processed++
        if (result.category === 'interested') {
          summary.interested++
          // Alert internally that a new interested reply landed in Review.
          alertQueue.push({
            email: String(row.lead_email ?? ''),
            subject: (row.subject as string) ?? null,
            company: (row.company_name as string) ?? null,
          })
        }
        // Queue auto-unsubscribe: AI says they want out → honour it. Only when
        // we know the client's workspace (mapped) so we hit the right Bison team.
        if (result.category === 'unsubscribe' && row.workspace_id && row.lead_email) {
          unsubQueue.push({ workspaceId: String(row.workspace_id), email: String(row.lead_email) })
        }
      } catch (err) {
        // Backoff; give up after 3 attempts.
        await client.query(
          `UPDATE unibox_replies
              SET classify_attempts = classify_attempts + 1,
                  classify_next_at = NOW() + (interval '5 minutes' * (classify_attempts + 1)),
                  classify_state = CASE WHEN classify_attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
                  ai_reasoning = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, `classify error: ${String(err).slice(0, 300)}`]
        )
        summary.failed++
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[cron/classify] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    client.release()
  }

  // After commit: honour unsubscribe requests in Bison (unsubscribe + blocklist).
  // Best-effort; serialized per Bison team inside the helpers. Failures are logged
  // but don't fail the cron — the row is already filed as 'rejected'/unsubscribe.
  for (const { workspaceId, email } of unsubQueue) {
    const teamId = bisonTeamForWorkspace(workspaceId)
    if (!teamId) continue
    try {
      await unsubscribeLead(teamId, email)
      await addToBlocklist(teamId, email)
      summary.unsubscribed++
    } catch (err) {
      console.error('[cron/classify] auto-unsub failed:', email, String(err))
    }
  }

  // After commit: alert internally about each new interested reply. Best-effort.
  for (const a of alertQueue) {
    const who = [a.company, a.email].filter(Boolean).join(' · ') || 'a lead'
    const subj = a.subject ? `\n\nSubject: ${a.subject}` : ''
    try {
      await sendEmail(
        INTERESTED_ALERT_TO,
        `🔥 New interested reply — ${a.company || a.email || 'lead'}`,
        `A new interested reply just landed in the Unibox review folder.\n\nFrom: ${who}${subj}\n\nReview it: https://login.ottaly.co.uk/admin/unibox`,
        `interested/${a.email}/${a.subject ?? ''}`,
      )
    } catch (err) {
      console.error('[cron/classify] interested alert failed:', a.email, String(err))
    }
  }

  return NextResponse.json(summary)
}
