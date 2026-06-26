import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { classifyReply, CLASSIFIER_MODEL, CLASSIFIER_VERSION, detectWarmupFull, setCustomWarmupTerms, defaultFolderForCategory } from '@/lib/classify'
import { addToBlocklist, unsubscribeLead, bisonTeamForWorkspace } from '@/lib/bison'
import { enrichReplyWithCH } from '@/lib/enrich'
// Triage worker for the Master Unibox. Claims a batch of pending replies with
// FOR UPDATE SKIP LOCKED (safe to run concurrently / overlapping), pre-filters
// automated replies for free, and calls Claude on the rest. Authed by
// ?secret=CRON_SECRET like the other crons.
export const dynamic = 'force-dynamic'
export const maxDuration = 300
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ready()

  // ?force=1 ignores the retry-backoff window so rows that failed during an
  // outage (e.g. Gemini out of credit) reclassify immediately instead of waiting
  // out their exponential backoff.
  const force = new URL(req.url).searchParams.get('force') === '1'

  // Load admin custom warm-up terms ONCE per run (built-in defaults are always
  // on; these extend them). detectWarmupFull/matchWarmupTag then check both.
  try {
    const ct = await pool.query(`SELECT term FROM unibox_warmup_terms WHERE source = 'custom'`)
    setCustomWarmupTerms(ct.rows.map(r => r.term as string))
  } catch { setCustomWarmupTerms([]) }

  const summary = { processed: 0, interested: 0, failed: 0, unsubscribed: 0, enriched: 0 }
  // Unsubscribe actions to run AFTER commit (network + stateful Bison switch).
  const unsubQueue: { workspaceId: string; email: string }[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Claim up to 50 due pending rows; SKIP LOCKED lets parallel runs not collide.
    // Join the lead record (esp_leads + its raw) for the alert's contact details.
    const claimed = await client.query(
      `SELECT u.id, u.subject, u.body_preview, u.raw, u.workspace_id, u.lead_email, u.bison_team_id,
              u.is_forwarded, u.classify_attempts,
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
        WHERE u.classify_state IN ('pending', 'failed')
          AND (${force ? 'TRUE' : '(u.classify_next_at IS NULL OR u.classify_next_at <= NOW())'})
        ORDER BY u.received_at ASC
        LIMIT 25
        FOR UPDATE OF u SKIP LOCKED`
    )

    // HARD TIME BUDGET. Each row does a Gemini call (~1-2s) inside this open
    // transaction; 25-50 of them blew past cron-job.org's 30s kill, which logged
    // nothing and tripped the failure alarm. Stop at ~22s and COMMIT what's done;
    // the rest stay pending/claimable for the next minute's run.
    const DEADLINE = Date.now() + 22_000
    for (const row of claimed.rows) {
      if (Date.now() > DEADLINE) break
      const id = row.id as string
      const raw = (row.raw ?? {}) as Record<string, unknown>
      // Bison pre-filter. Our mailboxes are STILL on Bison, so Bison still flags its
      // own warm-up / OOO / auto-acks with automated_reply=true — a real, wanted
      // signal we must keep to hide that traffic. (It did NOT cause the Simon Cook /
      // Brett Ewen losses — those were the repeated-word REGEX, now removed. This
      // explicit flag is reliable.) Safety net: matched rows go to the 'warmup'
      // folder, which is VISIBLE in the warm-up tab — so anything mis-flagged stays
      // findable and correctable, never silently deleted.
      const replyObj = (raw.reply ?? {}) as Record<string, unknown>
      const automated =
        raw.automated_reply === true || raw.automated_reply === 'true' ||
        replyObj.automated_reply === true || replyObj.automated_reply === 'true'

      if (automated) {
        await client.query(
          `UPDATE unibox_replies
              SET category = 'ooo_auto_reply', classify_state = 'done',
                  ai_model = 'prefilter', ai_reasoning = 'Bison automated_reply flag',
                  folder = CASE
                    WHEN folder IN ('inbox','review','unmapped','other')
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
      // Authoritative warm-up check: the PV/Bison per-mailbox filter tags
      // (e.g. "removal-thirty") matched in subject/body/raw, plus the structural
      // apple-apple token. This is what catches PV warm-ups that otherwise fool
      // Gemini into "interested". rawText pulls the full body (body_preview is
      // truncated at 500 chars and may cut off before the tag).
      // Use the FULL serialized raw (capped) as the warm-up haystack so the tag is
      // caught wherever it's stored (top-level text_body, nested reply.text_body,
      // html_body, etc.) — body_preview is truncated at 500 chars.
      let rawText = ''
      try { rawText = JSON.stringify(raw).slice(0, 12000) } catch { rawText = '' }
      const warmup = await detectWarmupFull(String(row.workspace_id ?? ''), {
        subject: (row.subject as string) ?? '',
        bodyText: (row.body_preview as string) ?? '',
        rawText,
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
        // Recover the body: body_preview is null for many ingested replies (the
        // Bison list endpoint and inbound spam-to-mailbox often carry only an html
        // body). Pull text from the raw payload so the classifier judges real
        // content instead of returning "other — empty body" and flooding Review.
        const rawObj = (raw ?? {}) as { text_body?: string; html_body?: string; body?: { text?: string; html?: string } }
        const fromRaw = (rawObj.text_body || rawObj.body?.text
          || (rawObj.html_body || rawObj.body?.html || '').replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ').trim()
        const subject = (row.subject as string) ?? ''
        const bodyText = ((row.body_preview as string) ?? '').trim() || fromRaw

        // No body at all → unjudgeable noise (mostly inbound spam/marketing sent TO
        // the mailbox). Archive to 'done' so it never clutters Review. Recoverable,
        // and a later re-ingest that carries a body will re-classify it properly.
        if (!bodyText) {
          await client.query(
            `UPDATE unibox_replies SET category='other', classify_state='done', folder='done',
                    ai_model='prefilter', ai_reasoning='empty body — archived',
                    classifier_version=$2, updated_at=NOW()
              WHERE id=$1`,
            [id, CLASSIFIER_VERSION]
          )
          summary.processed++
          continue
        }

        const result = await classifyReply({ subject, bodyText })
        // SIMPLIFIED ROUTING (never hide a possible lead):
        //   • a reply from an ALREADY-marked lead → 'lead_replies' (client follow-up)
        //   • else folder = defaultFolderForCategory(): confident noise goes to its
        //     own folder (warmup/unsubscribe/ooo) or confident not_interested; and
        //     EVERYTHING else — interested, question, "other", low-confidence — → Review.
        const m = await client.query(
          `SELECT 1 FROM unibox_replies
            WHERE workspace_id = $1 AND lower(lead_email) = lower($2)
              AND marked_as_lead = TRUE AND id <> $3 LIMIT 1`,
          [row.workspace_id, row.lead_email, id]
        ).catch(() => ({ rows: [] as unknown[] }))
        const alreadyLead = m.rows.length > 0
        const folder = alreadyLead ? 'lead_replies' : defaultFolderForCategory(result.category, result.confidence)
        await client.query(
          `UPDATE unibox_replies
              SET category = $2, confidence = $3, ai_model = $4, ai_reasoning = $5,
                  classify_state = 'done', classifier_version = $7,
                  folder = CASE WHEN folder IN ('inbox','review','unmapped','other') THEN $6 ELSE folder END,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, result.category, result.confidence, CLASSIFIER_MODEL,
           result.reasoning, folder, CLASSIFIER_VERSION]
        )
        summary.processed++
        if (result.category === 'interested' || result.category === 'question') {
          summary.interested++
          // Positive reply → enrich with verified Companies House data so the
          // rundown is ready in the unibox. Fire-and-forget (uses the pool, not
          // this cron's txn client); CH skips already-matched rows. Only positive
          // categories get a lookup — never OOO/warmup/unsubscribe/not-interested.
          const chEmail = String(row.lead_email ?? '')
          if (chEmail) {
            void enrichReplyWithCH(id, {
              email: chEmail,
              companyName: (row.lead_company as string | null) ?? (row.company_name as string | null) ?? null,
            }).catch(() => {})
          }
        }
        // Queue auto-unsubscribe: AI says they want out → honour it. Only when
        // we know the client's workspace (mapped) so we hit the right Bison team.
        if (result.category === 'unsubscribe' && row.workspace_id && row.lead_email) {
          unsubQueue.push({ workspaceId: String(row.workspace_id), email: String(row.lead_email) })
        }
      } catch (err) {
        // NEVER permanently give up on a reply — that left replies stuck invisible
        // when Gemini had an outage. Two guarantees here:
        //  1. The row stays 'pending' (retryable) forever, with an escalating
        //     backoff CAPPED at 6h, so it keeps retrying slowly until Gemini
        //     recovers — instead of dying at 3 attempts.
        //  2. A reply in a hidden intake folder is surfaced to Review, so even if
        //     it never classifies, an operator still SEES it.
        await client.query(
          `UPDATE unibox_replies
              SET classify_attempts = classify_attempts + 1,
                  classify_next_at = NOW() + LEAST(interval '6 hours',
                                                   interval '5 minutes' * (classify_attempts + 1)),
                  classify_state = 'pending',
                  folder = CASE WHEN folder IN ('inbox','unmapped') THEN 'review' ELSE folder END,
                  ai_reasoning = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, `classify error (attempt ${(row.classify_attempts ?? 0) + 1}): ${String(err).slice(0, 280)}`]
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

  // ── ENRICHMENT PASS ─────────────────────────────────────────────────────────
  // Companies-House enrichment used to run ONLY for rows this classify loop
  // processed (pending→done). But the ingest cron routes PV-labelled
  // interested/question replies STRAIGHT to 'done', so they skipped classify and
  // never got a CH lookup — new leads showed with just an email, no company panel
  // (the "replies don't have data anymore" regression). Fill them here: recent
  // positive replies that were never enriched (enrich_state IS NULL). Idempotent
  // (enrichReplyWithCH skips already-matched), bounded, and time-budgeted — CH is
  // rate-limited (~1-2s each) and classify's maxDuration is 300s.
  const ENRICH_DEADLINE = Date.now() + 120_000
  try {
    const pending = await pool.query(
      `SELECT u.id, u.lead_email,
              (SELECT company_name FROM esp_leads e
                WHERE e.workspace_id = u.workspace_id AND lower(e.email) = lower(u.lead_email)
                ORDER BY updated_at DESC NULLS LAST LIMIT 1) AS company_name
         FROM unibox_replies u
        WHERE COALESCE(u.admin_label, u.category) IN ('interested','question')
          AND u.enrich_state IS NULL
          AND u.lead_email IS NOT NULL AND u.lead_email <> ''
          AND u.received_at > NOW() - INTERVAL '14 days'
        ORDER BY u.received_at DESC
        LIMIT 60`
    )
    for (const r of pending.rows as { id: string; lead_email: string; company_name: string | null }[]) {
      if (Date.now() > ENRICH_DEADLINE) break
      await enrichReplyWithCH(r.id, { email: r.lead_email, companyName: r.company_name }).catch(() => {})
      summary.enriched++
    }
  } catch (err) {
    console.error('[cron/classify] enrichment pass failed:', String(err))
  }

  return NextResponse.json(summary)
}
