/**
 * The action queue and buy calendar.
 *
 * Turns measurements into a ranked list of what to do. Every item carries the
 * evidence that produced it, so nothing here is a recommendation you cannot
 * check.
 *
 * Nothing in this file writes to PlusVibe. These are proposals for a human,
 * and the ones that spend money say so.
 */

import { q } from './query'
import { clientSummary, rankByUrgency, judgeable, domainLoad, type RankedClient } from './mailbox-health-queries'
import { BURN_THRESHOLD } from './mailbox-health'
import { classifyAll, type RawBounce } from './bounce-classify'

/** 14 days warmup + ~6 days ramp before a new mailbox carries full load. */
const LEAD_TIME_DAYS = 20
const MBX_PER_DOMAIN = 3
const DOMAIN_COST_YEAR = 5.30
const MBX_COST_MONTH = 2.50

export type Severity = 'critical' | 'high' | 'medium' | 'low'
const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export interface Action {
  severity: Severity
  client: string | null
  title: string
  evidence: string
  action: string
  spends_money: boolean
  reversible: boolean
  mailboxes?: string[]
}

/**
 * Build the queue.
 *
 * Paused clients are excluded throughout: a client who is not sending cannot be
 * failing, so runway warnings for them are noise.
 */
export async function buildActions(client?: string): Promise<Action[]> {
  const states = await q<{ workspace_name: string; state: string }>(
    `SELECT workspace_name, state FROM mbx_client_state`, [], { tag: 'mailbox-actions:states' },
  )
  const paused = new Set(states.filter(s => s.state === 'paused').map(s => s.workspace_name))

  const clients = rankByUrgency(await clientSummary(client)).filter(c => c.state === 'active')
  const mailboxes = (await judgeable({ client })).filter(m => !paused.has(m.client))
  const domains = (await domainLoad(client)).filter(d => !paused.has(d.client))

  const actions: Action[] = []

  // ── bounces that say OUR sending is the problem ───────────────────────────
  // Measured, not inferred, and it outranks everything else: a mailbox landing
  // in spam is not underperforming, it is not being seen.
  const bounceRows = await q<RawBounce & { workspace_name: string | null }>(
    `SELECT e.raw->>'msg' AS msg, e.raw->>'sender_email' AS sender_email,
            e.lead_email, e.workspace_id, e.event_at, m.workspace_name
       FROM email_events e
       LEFT JOIN LATERAL (
         SELECT workspace_name FROM mailbox_full WHERE workspace_id = e.workspace_id LIMIT 1
       ) m ON TRUE
      WHERE e.event_type = 'bounce'
        AND e.event_at >= now() - interval '3 days'
        AND COALESCE(e.raw->>'msg', '') <> ''
        AND ($1::text IS NULL OR m.workspace_name = $1)`,
    [client ?? null], { tag: 'mailbox-actions:bounces' },
  )
  const classified = classifyAll(bounceRows)

  // The tenant ceiling is SHARED, so this is counted estate-wide. A per-client
  // rule cannot see it: Shire bounced at 489 sends/day having been clean at 725
  // the day before, and the bouncing migrated between clients as each consumed
  // the headroom.
  const tenant = classified.filter(b => b.cause === 'tenant_rate_limit')
  if (tenant.length >= 10) {
    const days = new Set(tenant.map(b => new Date(b.event_at).toISOString().slice(0, 10)))
    const hitClients = new Set(tenant.map(b => (b as { workspace_name?: string }).workspace_name).filter(Boolean))
    actions.push({
      severity: 'critical',
      client: null,
      title: `Tenant rate limit: ${tenant.length} bounces across ${hitClients.size} clients`,
      evidence: `Microsoft 5.7.233 over ${days.size} day(s). The limit belongs to the whole `
        + `tenant, not to any one client, so no per-client rate can see it and pausing one `
        + `client does not help.`,
      action: 'Lower total daily volume across the affected clients, not one of them.',
      spends_money: false,
      reversible: true,
    })
  }

  // Everything else our sending caused, grouped per client.
  const ourFaultByClient = new Map<string, typeof classified>()
  for (const b of classified) {
    if (!b.sending_fault || b.cause === 'tenant_rate_limit') continue
    const ws = (b as { workspace_name?: string }).workspace_name
    if (!ws || paused.has(ws)) continue
    const list = ourFaultByClient.get(ws) ?? []
    list.push(b)
    ourFaultByClient.set(ws, list)
  }
  for (const [ws, list] of ourFaultByClient) {
    if (list.length < 5) continue
    const causes = [...new Set(list.map(b => b.cause.replace(/_/g, ' ')))].join(', ')
    actions.push({
      severity: list.length >= 20 ? 'high' : 'medium',
      client: ws,
      title: `${ws}: ${list.length} bounces we caused in 3 days`,
      evidence: `Causes: ${causes}. These are our sending, not dead addresses or `
        + `recipient policy — those are excluded here.`,
      action: 'Read the Bounces tab: the cause decides whether to fix copy, DNS, or volume.',
      spends_money: false,
      reversible: true,
    })
  }

  // ── clients running out of runway ─────────────────────────────────────────
  for (const c of clients) {
    if (c.over_threshold || c.runway_months === null) continue
    if (c.runway_months > 3) continue
    actions.push({
      severity: c.runway_months <= 1 ? 'critical' : 'high',
      client: c.client,
      title: `${c.client}: ${c.runway_months} ${c.runway_months === 1 ? 'month' : 'months'} of runway`,
      evidence: `Averages ${c.avg_cum} lifetime sends across ${c.mailboxes} mailboxes at `
        + `${c.sends_per_mbx_per_day}/mbx/day. ${c.past_threshold} are already past `
        + `${BURN_THRESHOLD}.`,
      action: 'Start rest cycles to extend runway, or plan replacements now — a new mailbox '
        + `needs ${LEAD_TIME_DAYS} days before it carries load.`,
      spends_money: false,
      reversible: true,
    })
  }

  // ── past the threshold AND it is showing ──────────────────────────────────
  // Being past 350 is not itself a problem. Enviro sits at 1,821 lifetime sends
  // and returns 9.16% OOO because it rests. Past-threshold PLUS a weak rate is
  // the real signal.
  const estateOoo = clients.reduce((s, c) => s + (c.ooo_90d || 0), 0)
    / Math.max(1, clients.reduce((s, c) => s + (c.contacted_90d || 0), 0)) * 100
  for (const c of clients) {
    if (!c.over_threshold || c.ooo_pct === null) continue
    if (c.ooo_pct >= estateOoo * 0.85) continue
    actions.push({
      severity: c.ooo_pct < estateOoo * 0.6 ? 'high' : 'medium',
      client: c.client,
      title: `${c.client}: past threshold and underperforming`,
      evidence: `${c.avg_cum} avg lifetime sends (${c.past_threshold}/${c.mailboxes} past `
        + `${BURN_THRESHOLD}) at ${c.ooo_pct}% OOO against an estate average of `
        + `${estateOoo.toFixed(2)}%`
        + (c.emails_per_positive ? `, ${c.emails_per_positive} emails per positive.` : '.'),
      action: 'Rest the worst mailboxes, or rotate onto new domains if rest has already failed.',
      spends_money: false,
      reversible: true,
    })
  }

  // ── individual weak mailboxes ─────────────────────────────────────────────
  const weakByClient = new Map<string, typeof mailboxes>()
  for (const m of mailboxes) {
    if ((m.ooo_pct ?? 99) >= 1.5) continue
    const list = weakByClient.get(m.client) ?? []
    list.push(m)
    weakByClient.set(m.client, list)
  }
  for (const [c, list] of weakByClient) {
    const zero = list.filter(m => (m.ooo ?? 0) === 0).length
    actions.push({
      severity: list.length >= 10 ? 'high' : 'medium',
      client: c,
      title: `${c}: ${list.length} mailboxes below 1.5% OOO`,
      evidence: `${list.length} mailboxes with 100+ contacted are under 1.5% OOO, ${zero} at `
        + `zero. Average ${Math.round(list.reduce((s, m) => s + m.lifetime_sends, 0) / list.length)} `
        + `lifetime sends.`,
      action: zero >= list.length * 0.4
        ? 'Check whether these are burnt (rest) or badly provisioned (new domains) before spending.'
        : 'Throttle and review after 30 days.',
      spends_money: false,
      reversible: true,
      mailboxes: list.slice(0, 50).map(m => m.email),
    })
  }

  // ── domain volume ─────────────────────────────────────────────────────────
  // Sends-per-domain correlates with OOO at r = -0.47 against -0.10 for
  // headcount, so a domain is judged on volume per mailbox. Bulk-provisioned
  // domains run 20-99 mailboxes at a low rate BY DESIGN and must never be
  // flagged for their headcount.
  for (const d of domains.filter(x => x.sent_per_mbx > 800 && x.sent_90d > 3000).slice(0, 10)) {
    const bulk = d.mailboxes >= 20
    actions.push({
      severity: (d.ooo_pct ?? 99) < 3 ? 'high' : 'medium',
      client: d.client,
      title: `${d.domain}: ${d.sent_90d.toLocaleString()} sends on one domain in 90 days`,
      evidence: `${d.mailboxes} mailboxes averaging ${d.sent_per_mbx} sends each at `
        + `${d.ooo_pct}% OOO.`
        + (bulk ? ' This is a bulk-provisioned domain, so the mailbox count is by design — '
          + 'the volume per mailbox is the part worth watching.' : ''),
      action: bulk
        ? 'Lower the per-mailbox daily limit rather than splitting the domain.'
        : 'Cap volume or spread across more domains.',
      spends_money: false,
      reversible: true,
    })
  }

  return actions.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
}

export interface BuyLine {
  client: string
  mailboxes_needed: number
  domains_needed: number
  order_by: string
  order_in_days: number
  overdue: boolean
  est_cost: number
  reason: string
  note: string
}

/**
 * When to order, working back from when capacity is needed.
 *
 * Past the threshold is NOT by itself a reason to buy — Enviro is at 1,821
 * lifetime sends returning 9.16% OOO, and replacing it would burn money to fix
 * nothing. Buy only when the burn is visibly costing performance, or when a
 * client is about to run out of runway.
 */
export async function buyCalendar(client?: string): Promise<BuyLine[]> {
  const clients = rankByUrgency(await clientSummary(client)).filter(c => c.state === 'active')
  const estateOoo = clients.reduce((s, c) => s + (c.ooo_90d || 0), 0)
    / Math.max(1, clients.reduce((s, c) => s + (c.contacted_90d || 0), 0)) * 100

  const out: BuyLine[] = []
  for (const c of clients) {
    if (c.runway_months === null) continue
    const ooo = c.ooo_pct ?? 0
    const hurting = c.over_threshold && ooo < estateOoo * 0.85
    const approaching = !c.over_threshold && c.runway_months <= 2
    if (!hurting && !approaching) continue

    const needed = hurting ? Math.max(1, c.past_threshold) : Math.max(1, Math.ceil(c.mailboxes * 0.25))
    const domainsNeeded = Math.ceil(needed / MBX_PER_DOMAIN)
    const neededInDays = Math.round((c.runway_months || 0) * 30)
    const orderInDays = Math.max(0, neededInDays - LEAD_TIME_DAYS)
    out.push({
      client: c.client,
      mailboxes_needed: needed,
      domains_needed: domainsNeeded,
      order_by: new Date(Date.now() + orderInDays * 86400000).toISOString().slice(0, 10),
      order_in_days: orderInDays,
      overdue: orderInDays === 0 && neededInDays < LEAD_TIME_DAYS,
      est_cost: Number((domainsNeeded * DOMAIN_COST_YEAR + needed * MBX_COST_MONTH).toFixed(2)),
      reason: hurting ? 'burn is costing performance' : 'running out of runway',
      note: hurting
        ? `${c.past_threshold} of ${c.mailboxes} past ${BURN_THRESHOLD}, ${ooo}% OOO vs estate ${estateOoo.toFixed(2)}%`
        : `${c.runway_months} ${c.runway_months === 1 ? 'month' : 'months'} of runway, ${ooo}% OOO`,
    })
  }
  return out.sort((a, b) => a.order_in_days - b.order_in_days)
}

export type { RankedClient }
