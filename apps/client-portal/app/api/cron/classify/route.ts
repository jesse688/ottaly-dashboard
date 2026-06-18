import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { classifyReply, CLASSIFIER_MODEL, CLASSIFIER_VERSION, detectWarmup } from '@/lib/classify'
import { addToBlocklist, unsubscribeLead, bisonTeamForWorkspace } from '@/lib/bison'
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
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Claim up to 50 due pending rows; SKIP LOCKED lets parallel runs not collide.
    // Join the lead record (esp_leads + its raw) for the alert's contact details.
    const claimed = await client.query(
      `SELECT u.id, u.subject, u.body_preview, u.raw, u.workspace_id, u.lead_email, u.bison_team_id,
              u.is_forwarded,
              c.company_name,
              l.first_name, l.last_name, l.company_name AS lead_company,
              l.raw->>'job_title'           AS job_title,
              l.raw->>'phone_number'        AS phone_number,
              l.raw->>'linkedin_person_url' AS linkedin_url,
              l.raw->>'company_website'     AS company_website,
              l.raw->>'city'                AS city,
              l.raw->>'country'             AS country
         FROM unibox_replies u
         LEFT JOIN portal_clients c ON c.workspace_id = u.workspace_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name, company_name, raw FROM esp_leads e
           WHERE e.workspace_id = u.workspace_id AND lower(e.email) = lower(u.lead_email)
           ORDER BY (e.source = 'bison') DESC, e.updated_at DESC LIMIT 1
         ) l ON TRUE
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
        // Bison already identified this as automated (warm-up / OOO / auto-ack).
        // File it to the hidden 'warmup' folder so it leaves the working queues —
        // but never move a row already with the client or human-reviewed.
        await client.query(
          `UPDATE unibox_replies
              SET category = 'ooo_auto_reply', classify_state = 'done',
                  ai_model = 'prefilter', ai_reasoning = 'Bison automated_reply flag',
                  folder = CASE
                    WHEN folder IN ('inbox','review','unmapped')
                         AND marked_as_lead = FALSE AND admin_label IS NULL
                    THEN 'warmup' ELSE folder END,
                  updated_at = NOW()
            WHERE id = $1`,
          [id]
        )
        summary.processed++
        continue
      }

      // Free pre-filter: warm-up emails (apple-apple etc.) are inbox-reputation
      // traffic, not real replies. The tell is a random hyphenated word-pair
      // injected into the prose. Warm-up tools now fake weak fields (a job_title,
      // a company name), so per Jesse: only STRONG enrichment — a LinkedIn URL or
      // a real company website — exempts a hyphen-pair reply from warm-up. A bare
      // email / job_title is not enough (that's how "interest-advance / journey-
      // region" warm-ups were slipping through to Gemini and coming back interested).
      const hasLeadFields = Boolean(
        row.linkedin_url || row.company_website
      )
      const warmup = detectWarmup({
        subject: (row.subject as string) ?? '',
        bodyText: (row.body_preview as string) ?? '',
        hasLeadFields,
        // A forwarded reply legitimately lacks lead fields — don't auto-warmup it.
        isForwarded: Boolean(row.is_forwarded),
      })
      if (warmup.isWarmup) {
        // Warmup goes to its OWN visible folder (not hidden 'rejected'), so a
        // genuine reply mis-flagged as warm-up stays findable for correction.
        await client.query(
          `UPDATE unibox_replies
              SET category = 'warmup', classify_state = 'done', folder = 'warmup',
                  ai_model = 'prefilter', ai_reasoning = $2,
                  classifier_version = $3, updated_at = NOW()
            WHERE id = $1`,
          [id, warmup.reason, CLASSIFIER_VERSION]
        )
        summary.processed++
        continue
      }

      try {
        const result = await classifyReply({
          subject: (row.subject as string) ?? '',
          bodyText: (row.body_preview as string) ?? '',
        })
        // interested + question → Review for manual decision (a pricing/clarifying
        // question is a hot lead). unsubscribe → auto-actioned, filed 'rejected'.
        // BUT if this lead was ALREADY marked as a lead (an earlier reply), this is a
        // follow-up to the CLIENT — it must NOT clutter Review. Route to 'replies'.
        let alreadyLead = false
        if (result.category === 'interested' || result.category === 'question') {
          const m = await client.query(
            `SELECT 1 FROM unibox_replies
              WHERE workspace_id = $1 AND lower(lead_email) = lower($2)
                AND marked_as_lead = TRUE AND id <> $3 LIMIT 1`,
            [row.workspace_id, row.lead_email, id]
          ).catch(() => ({ rows: [] as unknown[] }))
          alreadyLead = m.rows.length > 0
        }
        const folder = alreadyLead ? 'replies'
                     : (result.category === 'interested' || result.category === 'question') ? 'review'
                     : result.category === 'unsubscribe' ? 'rejected'
                     : undefined
        await client.query(
          `UPDATE unibox_replies
              SET category = $2, confidence = $3, ai_model = $4, ai_reasoning = $5,
                  classify_state = 'done', classifier_version = $7,
                  folder = CASE WHEN $6::text IS NOT NULL AND folder IN ('inbox','review') THEN $6 ELSE folder END,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, result.category, result.confidence, CLASSIFIER_MODEL,
           result.reasoning, folder ?? null, CLASSIFIER_VERSION]
        )
        summary.processed++
        if (result.category === 'interested' || result.category === 'question') {
          summary.interested++
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

  return NextResponse.json(summary)
}
