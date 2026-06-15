import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { classifyReply, CLASSIFIER_MODEL } from '@/lib/classify'

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

  const summary = { processed: 0, interested: 0, failed: 0 }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Claim up to 50 due pending rows; SKIP LOCKED lets parallel runs not collide.
    const claimed = await client.query(
      `SELECT id, subject, body_preview, raw
         FROM unibox_replies
        WHERE classify_state = 'pending'
          AND (classify_next_at IS NULL OR classify_next_at <= NOW())
        ORDER BY received_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED`
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
        const folder = result.category === 'interested' ? 'review' : undefined
        await client.query(
          `UPDATE unibox_replies
              SET category = $2, confidence = $3, ai_model = $4, ai_reasoning = $5,
                  classify_state = 'done',
                  folder = CASE WHEN $6::text IS NOT NULL AND folder = 'inbox' THEN $6 ELSE folder END,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, result.category, result.confidence, CLASSIFIER_MODEL,
           result.reasoning, folder ?? null]
        )
        summary.processed++
        if (result.category === 'interested') summary.interested++
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

  return NextResponse.json(summary)
}
