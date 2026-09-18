import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'
import { classifyAll, listedDomain, type ClassifiedBounce } from '@/lib/bounce-classify'

export const dynamic = 'force-dynamic'

/**
 * Bounces, read from email_events and classified by CAUSE.
 *
 * A bounce count cannot say what to do. Measured across 7,022 bounces, 48% say
 * nothing about our sending at all — dead addresses, full mailboxes, recipient
 * policy. A raw bounce rate counts those identically to real faults, which is
 * how three healthy mailboxes came to be paused on a ">2% bounce" rule.
 *
 * Classification happens in JS rather than SQL deliberately: a SQL mirror of
 * the same rules disagreed with the TypeScript on 96 of 7,024 rows, and two
 * expressions of one rule set drift silently. These rows are fetched to display
 * anyway, so classifying them costs nothing measurable.
 */

/** Estate-wide 5.7.233 events in a day before the tenant ceiling is called. */
const TENANT_ALERT = 10
/** Sends before a bounce RATE means anything. */
const MIN_SENDS = 50

interface EventRow {
  msg: string | null
  sender_email: string | null
  lead_email: string | null
  workspace_id: string | null
  workspace_name: string | null
  event_at: string
}

export async function GET(req: NextRequest) {
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || 30))
  const client = req.nextUrl.searchParams.get('client') || null
  try {
    const rows = await q<EventRow>(
      `SELECT e.raw->>'msg'          AS msg,
              e.raw->>'sender_email' AS sender_email,
              e.lead_email,
              e.workspace_id,
              m.workspace_name,
              e.event_at
         FROM email_events e
         LEFT JOIN LATERAL (
           SELECT workspace_name FROM mailbox_full
            WHERE workspace_id = e.workspace_id LIMIT 1
         ) m ON TRUE
        WHERE e.event_type = 'bounce'
          AND e.event_at >= now() - ($1::int || ' days')::interval
          AND COALESCE(e.raw->>'msg', '') <> ''
          AND ($2::text IS NULL OR m.workspace_name = $2)`,
      [days, client], { tag: 'mailbox-health:bounces' },
    )

    const classified = classifyAll(rows)

    // ── by cause ──────────────────────────────────────────────────────────
    const causes = new Map<string, { cause: string; action: string; bounces: number; mailboxes: Set<string>; clients: Set<string> }>()
    for (const b of classified) {
      const c = causes.get(b.cause) ?? {
        cause: b.cause, action: b.action, bounces: 0,
        mailboxes: new Set<string>(), clients: new Set<string>(),
      }
      c.bounces++
      if (b.sender_email) c.mailboxes.add(b.sender_email)
      const ws = (b as ClassifiedBounce & { workspace_name?: string }).workspace_name
      if (ws) c.clients.add(ws)
      causes.set(b.cause, c)
    }

    // ── the tenant ceiling, estate-wide ───────────────────────────────────
    // This is the detection that matters and it CANNOT be per client. The
    // limit is shared across the whole Microsoft tenant: Shire bounced at 489
    // sends/day having been clean at 725 the day before, and on 17-18 Sep it
    // hit 10 unrelated clients while each one's own rate looked survivable.
    const tenantByDay = new Map<string, { date: string; bounces: number; clients: Set<string>; mailboxes: Set<string> }>()
    for (const b of classified) {
      if (b.cause !== 'tenant_rate_limit') continue
      const date = new Date(b.event_at).toISOString().slice(0, 10)
      const d = tenantByDay.get(date) ?? { date, bounces: 0, clients: new Set<string>(), mailboxes: new Set<string>() }
      d.bounces++
      const ws = (b as ClassifiedBounce & { workspace_name?: string }).workspace_name
      if (ws) d.clients.add(ws)
      if (b.sender_email) d.mailboxes.add(b.sender_email)
      tenantByDay.set(date, d)
    }
    const tenantDays = [...tenantByDay.values()]
      .map(d => ({ date: d.date, tenant_bounces: d.bounces, clients_hit: d.clients.size, mailboxes_hit: d.mailboxes.size }))
      .sort((a, b) => b.date.localeCompare(a.date))

    // ── per mailbox ───────────────────────────────────────────────────────
    const byMailbox = new Map<string, { email: string; client: string | null; bounces: number; tenant: number; sending_faults: number; not_ours: number; causes: Set<string>; last: string }>()
    for (const b of classified) {
      if (!b.sender_email) continue
      const m = byMailbox.get(b.sender_email) ?? {
        email: b.sender_email,
        client: (b as ClassifiedBounce & { workspace_name?: string }).workspace_name ?? null,
        bounces: 0, tenant: 0, sending_faults: 0, not_ours: 0,
        causes: new Set<string>(), last: String(b.event_at),
      }
      m.bounces++
      if (b.cause === 'tenant_rate_limit') m.tenant++
      if (b.sending_fault) m.sending_faults++; else m.not_ours++
      m.causes.add(b.cause)
      if (String(b.event_at) > m.last) m.last = String(b.event_at)
      byMailbox.set(b.sender_email, m)
    }

    // ── domains with a standing fault ─────────────────────────────────────
    // Blocklist bounces name the LISTED domain, which is a URL inside the
    // email and not necessarily the sender, so it is read from the message
    // rather than assumed — blaming the sender could retire a healthy domain.
    const burned = new Map<string, { domain: string; cause: string; bounces: number; last: string }>()
    for (const b of classified) {
      if (b.action !== 'retire_domain' && b.action !== 'fix_dns') continue
      const domain = (b.cause === 'blocklisted' && listedDomain(b.msg))
        || (b.sender_email?.split('@')[1] ?? null)
      if (!domain) continue
      const key = `${domain}|${b.cause}`
      const d = burned.get(key) ?? { domain, cause: b.cause, bounces: 0, last: String(b.event_at) }
      d.bounces++
      if (String(b.event_at) > d.last) d.last = String(b.event_at)
      burned.set(key, d)
    }

    const worstTenantDay = tenantDays[0] ?? null

    return NextResponse.json({
      days,
      focus: client,
      thresholds: { tenant_alert: TENANT_ALERT, min_sends: MIN_SENDS },
      total: classified.length,
      // The headline split: how much of this is even our problem.
      our_fault: classified.filter(b => b.sending_fault).length,
      not_ours: classified.filter(b => !b.sending_fault).length,
      causes: [...causes.values()]
        .map(c => ({ cause: c.cause, action: c.action, bounces: c.bounces, mailboxes: c.mailboxes.size, clients: c.clients.size }))
        .sort((a, b) => b.bounces - a.bounces),
      tenant_by_day: tenantDays,
      tenant_alert: !!(worstTenantDay && worstTenantDay.tenant_bounces >= TENANT_ALERT),
      tenant_worst_day: worstTenantDay,
      mailboxes: [...byMailbox.values()]
        .map(m => ({ ...m, causes: [...m.causes].join(', ') }))
        .sort((a, b) => b.tenant - a.tenant || b.sending_faults - a.sending_faults)
        .slice(0, 200),
      burned_domains: [...burned.values()].sort((a, b) => b.bounces - a.bounces),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:bounces' }, extra: { days, client } })
    const msg = err instanceof Error ? err.message : 'Failed to load bounces'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
