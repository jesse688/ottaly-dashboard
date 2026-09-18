import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import crypto from 'crypto'
import pool from '@/lib/db'
import { classify, statusCode } from '@/lib/bounce-classify'

export const dynamic = 'force-dynamic'

/**
 * Bounce webhook receiver.
 *
 * PlusVibe pushes every bounce as it happens (event type BOUNCED_EMAIL, shown
 * in its UI as "All Bounced Emails"). That beats polling twice over: it arrives
 * immediately rather than up to an hour later, and costs nothing against the
 * shared PV gate.
 *
 * PUBLIC PATH. PlusVibe posts here unauthenticated, so this route must be
 * listed in PUBLIC_PATHS in middleware.ts and validate callers itself — same
 * shape as /api/data/esp-matching/enforce. It checks PV_WEBHOOK_SECRET when one
 * is configured; without a secret it accepts anything, which is why one should
 * be set in production.
 *
 * The payload shape below was CAPTURED from a live webhook on 2026-09-18, not
 * guessed, and it does NOT match list_all_leads:
 *
 *   { webhook_event, workspace_id, workspace_name, camp_id, campaign_id,
 *     campaign_name, is_camp_paused, date, sender_email, sender_mx,
 *     lead_email, lead_mx, is_verified, msg, bounce_type }
 *
 * Three differences that would have broken a guessed implementation: the bounce
 * text is `msg` not `bounce_msg`, the sending mailbox is `sender_email` (an
 * address, not an id), and there is NO lead id at all.
 */

/** PlusVibe posts a sample payload when a webhook is created. Not a real bounce. */
function isTestPayload(body: Record<string, unknown>): boolean {
  return /John Doe Workspace/i.test(String(body.workspace_name ?? ''))
    || /yourcompany\.com$/i.test(String(body.sender_email ?? ''))
    || /nonexistent-domain\.com$/i.test(String(body.lead_email ?? ''))
}

function verify(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.PV_WEBHOOK_SECRET
  if (!secret) return true               // nothing configured, nothing to check
  const sig = req.headers.get('x-webhook-signature')
    || req.headers.get('x-plusvibe-signature')
    || req.headers.get('x-signature')
  if (!sig) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const given = sig.replace(/^sha256=/, '')
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (!verify(req, raw)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = JSON.parse(raw) } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Storing PlusVibe's sample would file a fake bounce against a mailbox that
  // does not exist.
  if (isTestPayload(body)) {
    return NextResponse.json({ ok: true, stored: false, reason: 'PlusVibe test payload' })
  }

  const msg = String(body.msg ?? body.bounce_msg ?? '')
  if (!msg.trim()) {
    return NextResponse.json({ ok: true, stored: false, reason: 'no bounce message' })
  }

  const senderEmail = String(body.sender_email ?? '').toLowerCase() || null
  const leadEmail = String(body.lead_email ?? '').toLowerCase() || null
  const workspaceId = String(body.workspace_id ?? '') || null
  const eventAt = body.date ? new Date(String(body.date)) : new Date()
  const cause = classify(msg)

  try {
    // Write into email_events, the shared bounce store, so a pushed bounce and
    // a polled one land in the same place and the whole system reads one table.
    // ON CONFLICT DO NOTHING matches how the backfill writes it.
    await pool.query(
      `INSERT INTO email_events (workspace_id, event_type, event_at, campaign_id, lead_email, raw)
       VALUES ($1, 'bounce', $2, $3, $4, $5::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        workspaceId,
        eventAt.toISOString(),
        body.camp_id ?? body.campaign_id ?? null,
        leadEmail,
        JSON.stringify({
          msg,
          sender_email: senderEmail,
          sender_mx: body.sender_mx ?? null,
          lead_mx: body.lead_mx ?? null,
          bounce_type: body.bounce_type ?? null,
          source: 'webhook',
        }),
      ],
    )

    // An unclassified bounce arriving live means a rule is missing WHILE
    // bounces are landing — worth seeing immediately rather than in a report.
    if (cause.key === 'unknown') {
      console.warn('[bounce-webhook] UNCLASSIFIED:', msg.slice(0, 160))
    }

    return NextResponse.json({
      ok: true, stored: true,
      cause: cause.key, action: cause.action,
      status_code: statusCode(msg),
      sender: senderEmail,
    })
  } catch (err) {
    Sentry.captureException(err, {
      tags: { tag: 'mailbox-health:bounce-webhook' },
      extra: { sender: senderEmail, cause: cause.key },
    })
    // Still answer 200: a webhook sender that sees an error usually retries,
    // and a retry storm helps nobody. The failure is captured above.
    return NextResponse.json({ ok: false, error: 'store failed' })
  }
}
