import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'
import {
  pauseMailboxes, setLimit, randomiseLimits, setRestCycle, undoChange,
} from '@/lib/mailbox-actuator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Apply a change to PlusVibe. The only write endpoint in mailbox health.
 *
 * DRY RUN BY DEFAULT. A body without `apply: true` returns exactly what WOULD
 * change and touches nothing. That is deliberate: this endpoint alters live
 * sending, and the failure mode of a mistaken call is client emails stopping.
 *
 * Every applied change is logged with each mailbox's PREVIOUS value, so it can
 * be undone exactly — mailboxes do not share a limit, and a single global
 * number would not be enough to restore them.
 *
 * Actions:
 *   pause      daily_limit -> 0. Cold sending stops, warmup keeps running.
 *   set_limit  lower (or raise) the daily limit
 *   randomise  limit_rand_pct estate-wide, PlusVibe recommends 40
 *   rest       enable rest cycles: N sending days, then M days off
 *   undo       restore a logged change
 */

interface Body {
  action?: 'pause' | 'set_limit' | 'randomise' | 'rest' | 'undo'
  emails?: string[]
  /** Select targets by finding instead of listing them. */
  target?: 'bouncing' | 'burnt' | 'faulty_domains'
  limit?: number
  pct?: number
  send_days?: number
  rest_days?: number
  change_id?: number
  client?: string
  reason?: string
  apply?: boolean
}

/**
 * Resolve a named finding to its mailboxes, so the UI can act on "the 137
 * bouncing mailboxes" without shipping 137 addresses back and forth — and so
 * the set cannot drift between what was shown and what is changed.
 */
async function resolveTarget(target: string, client?: string): Promise<string[]> {
  if (target === 'bouncing') {
    // Bounced on a cause WE caused in the last 3 days, and still sending.
    // Recipient-side causes are excluded: a dead address says nothing about
    // the mailbox, and a volume rule keyed on total bounce rate once paused
    // three healthy mailboxes for exactly that reason.
    const rows = await q<{ email: string }>(
      `SELECT DISTINCT m.email
         FROM email_events e
         JOIN mailbox_full m ON m.email = lower(e.raw->>'sender_email')
        WHERE e.event_type = 'bounce'
          AND e.event_at >= now() - interval '3 days'
          AND m.daily_limit > 0
          AND m.ignored_at IS NULL
          AND ($1::text IS NULL OR m.workspace_name = $1)
          AND (e.raw->>'msg' ILIKE '%5.7.233%'
            OR e.raw->>'msg' ILIKE '%spamhaus%' OR e.raw->>'msg' ILIKE '%surbl%'
            OR e.raw->>'msg' ILIKE '%5.7.350%' OR e.raw->>'msg' ILIKE '%5.7.509%'
            OR e.raw->>'msg' ILIKE '%access denied%')`,
      [client ?? null], { tag: 'mailbox-apply:target:bouncing' },
    )
    return rows.map(r => r.email)
  }
  if (target === 'burnt') {
    const rows = await q<{ email: string }>(
      `SELECT m.email FROM mailbox_full m
         JOIN (SELECT email, SUM(sent) s FROM mbx_daily GROUP BY email HAVING SUM(sent) >= 350) c
           ON c.email = m.email
        WHERE m.daily_limit > 0 AND m.ignored_at IS NULL
          AND ($1::text IS NULL OR m.workspace_name = $1)`,
      [client ?? null], { tag: 'mailbox-apply:target:burnt' },
    )
    return rows.map(r => r.email)
  }
  if (target === 'faulty_domains') {
    // Blocklisted or failing their own DMARC — every send bounces regardless
    // of rate, so volume changes cannot help.
    const rows = await q<{ email: string }>(
      `SELECT DISTINCT m.email
         FROM email_events e
         JOIN mailbox_full m ON m.email = lower(e.raw->>'sender_email')
        WHERE e.event_type = 'bounce'
          AND e.event_at >= now() - interval '30 days'
          AND m.daily_limit > 0 AND m.ignored_at IS NULL
          AND ($1::text IS NULL OR m.workspace_name = $1)
          AND (e.raw->>'msg' ILIKE '%spamhaus%' OR e.raw->>'msg' ILIKE '%surbl%'
            OR e.raw->>'msg' ILIKE '%5.7.509%' OR e.raw->>'msg' ILIKE '%does not pass DMARC%')`,
      [client ?? null], { tag: 'mailbox-apply:target:faulty' },
    )
    return rows.map(r => r.email)
  }
  return []
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Body
  const apply = body.apply === true
  const reason = String(body.reason ?? '').slice(0, 300) || 'mailbox health'

  try {
    const emails = body.emails?.length
      ? body.emails
      : body.target ? await resolveTarget(body.target, body.client) : []

    switch (body.action) {
      case 'pause':
        if (!emails.length) return NextResponse.json({ error: 'no mailboxes selected' }, { status: 400 })
        return NextResponse.json(await pauseMailboxes(emails, reason, apply))

      case 'set_limit': {
        if (!emails.length) return NextResponse.json({ error: 'no mailboxes selected' }, { status: 400 })
        const to = Number(body.limit)
        if (!Number.isFinite(to) || to < 0) {
          return NextResponse.json({ error: 'limit must be a number >= 0' }, { status: 400 })
        }
        return NextResponse.json(await setLimit(emails, to, reason, apply))
      }

      case 'randomise':
        return NextResponse.json(await randomiseLimits(Number(body.pct ?? 40), apply, body.client))

      case 'rest': {
        if (!emails.length) return NextResponse.json({ error: 'no mailboxes selected' }, { status: 400 })
        const send = Math.max(1, Math.min(60, Number(body.send_days ?? 10)))
        const rest = Math.max(1, Math.min(60, Number(body.rest_days ?? 7)))
        return NextResponse.json(await setRestCycle(emails, send, rest, apply))
      }

      case 'undo': {
        const id = Number(body.change_id)
        if (!Number.isFinite(id)) return NextResponse.json({ error: 'change_id required' }, { status: 400 })
        return NextResponse.json(await undoChange(id, apply))
      }

      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:apply' }, extra: { action: body.action, apply } })
    const msg = err instanceof Error ? err.message : 'apply failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** Recent changes, so the page can show what was done and offer an undo. */
export async function GET() {
  try {
    const rows = await q<{ id: string; applied_at: string; kind: string; reason: string | null; changes: unknown[]; undone_at: string | null }>(
      `SELECT id, applied_at, kind, reason, changes, undone_at
         FROM mbx_change_log ORDER BY id DESC LIMIT 25`,
      [], { tag: 'mailbox-apply:log' },
    )
    return NextResponse.json({
      changes: rows.map(r => ({
        id: Number(r.id),
        applied_at: r.applied_at,
        kind: r.kind,
        reason: r.reason,
        mailboxes: Array.isArray(r.changes) ? r.changes.length : 0,
        undone_at: r.undone_at,
      })),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    // The table may not exist until the first change is applied.
    return NextResponse.json({ changes: [], updatedAt: new Date().toISOString() })
  }
}
