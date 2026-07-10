// CM Triage model — pure, testable projection + reason-code + priority logic.
//
// Spec: given a client's monthly qualified-lead target and their live sending
// levers (reply efficiency, mailbox capacity, data on hand, whether they're
// sending), project WHERE THEY LAND at month-end and — if they'll miss — name
// the single binding constraint so a CM knows what to actually do.
//
// The guiding principle: "is the client sending?" is the wrong question. A client
// sending fine can still be projected to miss (thin data / low reply rate), and a
// client out of data can be safely left alone if they're already at target.
//
// All functions here are pure. I/O (DB reads) lives in the API route.

export type ReasonCode =
  | 'NOT_SENDING'
  | 'NO_DATA'
  | 'NOT_ENOUGH_MAILBOXES'
  | 'LOW_REPLY_RATE'
  | 'ON_TRACK'
  | 'AHEAD'
  | 'NO_TARGET'
  | 'TOO_EARLY'
  | 'WARMING_UP'

export type Bucket = 'needs_work' | 'structural' | 'leave_alone' | 'unscored'

/** Raw levers for one client, assembled by the API route from Postgres. */
export interface TriageInput {
  workspaceId: string
  workspaceName: string
  managers: string[] // assigned CM names (campaign_manager + _2)
  target: number // clients.lead_target_monthly (0 = no target)
  deliveredMtd: number // qualified leads this month from revenue_leads
  lpt: number | null // leads per 1000 sends (workspace_stats.lpt_30d, fallbacks applied upstream)
  dailyCapacity: number // avg_daily_per_mailbox × mailbox_count (sends/day)
  dataOnHand: number // un-emailed sendable contacts (contacts_total minus emailed)
  lastSentAt: string | null // ISO — recency drives is_sending
  clientStatus: string | null // 'active' | 'inactive'
  pricePerLead: number | null // for optional revenue weighting
  warmupUntil: string | null // ISO date warmup ends, or null
}

export interface TriageResult extends TriageInput {
  isSending: boolean
  daysInMonth: number
  dayOfMonth: number
  daysLeft: number
  sendsLeftPossible: number
  projectedNewLeads: number
  projectedMonthEnd: number
  gap: number // target − projected (>0 = will miss)
  paceRatio: number // projected / target (<1 = behind)
  reason: ReasonCode
  bucket: Bucket
  priority: number
  action: string
  lowConfidence: boolean // projection rests on thin data
}

// ── Tunables (from spec §2 decisions) ────────────────────────────────────────
export const MISS_THRESHOLD = 0.8 // projected < 80% of target → needs work
export const SENDING_RECENCY_DAYS = 3 // sent within N days = actively sending
export const EARLY_MONTH_GATE = 5 // don't score before day N (noise)
export const DEFAULT_DAILY_PER_MAILBOX = 30 // fallback if capacity unknown
// Benchmark leads-per-1000-sends a healthy campaign should achieve. Used ONLY to
// separate "not enough mailboxes" from "reply rate too low". ~20 ≈ a 4% reply
// rate with ~half converting to qualified leads. TUNE to your book's real median.
export const HEALTHY_LPT = 20

const FIXABILITY: Record<string, number> = {
  NOT_SENDING: 1.0,
  NO_DATA: 0.9,
  LOW_REPLY_RATE: 0.6,
  NOT_ENOUGH_MAILBOXES: 0.5,
}

const ACTIONS: Record<ReasonCode, string> = {
  NOT_SENDING: 'Not sending — campaign paused or mailboxes down. Investigate now.',
  NO_DATA: 'Runs out of leads before month-end — load data / kick the engine.',
  NOT_ENOUGH_MAILBOXES: 'Capacity-capped below target — add mailboxes / upsell infra.',
  LOW_REPLY_RATE: 'Copy or targeting underperforming — rework the campaign.',
  ON_TRACK: 'On track — leave alone.',
  AHEAD: 'Target already hit — consider reallocating mailboxes.',
  NO_TARGET: 'No monthly target set — configure a target to score this client.',
  TOO_EARLY: 'Too early in the month to score reliably.',
  WARMING_UP: 'Mailboxes still warming up — do not score as underperforming yet.',
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Calendar facts for the current month. `now` injected so callers stay pure/testable. */
export function monthClock(now: Date) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const dayOfMonth = now.getUTCDate()
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth)
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
  return { daysInMonth, dayOfMonth, daysLeft, monthStart }
}

function isSendingNow(lastSentAt: string | null, now: Date): boolean {
  if (!lastSentAt) return false
  const last = Date.parse(lastSentAt)
  if (Number.isNaN(last)) return false
  const days = (now.getTime() - last) / 86_400_000
  return days <= SENDING_RECENCY_DAYS
}

/**
 * Core evaluation for one client. Returns the full projection, the binding-
 * constraint reason, its bucket, and a priority score for sorting.
 */
export function evaluate(input: TriageInput, now: Date): TriageResult {
  const { daysInMonth, dayOfMonth, daysLeft } = monthClock(now)
  const isSending = isSendingNow(input.lastSentAt, now)

  // Capacity fallback: unknown/zero capacity → assume standard per-mailbox rate.
  const dailyCapacity = input.dailyCapacity > 0 ? input.dailyCapacity : DEFAULT_DAILY_PER_MAILBOX

  // Forward projection: how many more sends are realistically possible, capped by
  // BOTH mailbox throughput and remaining data — whichever runs out first.
  // If the client isn't sending RIGHT NOW, we project zero future sends — we do
  // not assume sending magically resumes. This is deliberate: a stalled client
  // must project to miss so it surfaces as NOT_SENDING rather than being masked
  // by an optimistic "if only they were sending" projection.
  const sendsByCapacity = isSending ? dailyCapacity * daysLeft : 0
  const sendsLeftPossible = Math.max(0, Math.min(sendsByCapacity, input.dataOnHand))

  // Efficiency: leads per 1000 sends. Null (thin data) → treat as low-confidence
  // and fall back to 0 leads projected from future sends (conservative).
  const lpt = input.lpt ?? 0
  const lowConfidence = input.lpt == null || input.target <= 0

  const projectedNewLeads = sendsLeftPossible * (lpt / 1000)
  const projectedMonthEnd = input.deliveredMtd + projectedNewLeads
  const gap = input.target - projectedMonthEnd
  const paceRatio = input.target > 0 ? projectedMonthEnd / input.target : 1

  const reason = classify(input, {
    isSending,
    dayOfMonth,
    daysLeft,
    dailyCapacity,
    lpt,
    projectedMonthEnd,
    paceRatio,
    now,
  })
  const bucket = bucketFor(reason)
  const action = ACTIONS[reason]

  // Priority: how far below target × how much target is at stake × how fixable.
  const gapSeverity = clamp(1 - paceRatio, 0, 1)
  const clientWeight = input.target // lead-volume weighting (spec decision)
  const fixability = FIXABILITY[reason] ?? 0
  const priority = gapSeverity * clientWeight * fixability

  return {
    ...input,
    isSending,
    daysInMonth,
    dayOfMonth,
    daysLeft,
    sendsLeftPossible,
    projectedNewLeads,
    projectedMonthEnd,
    gap,
    paceRatio,
    reason,
    bucket,
    priority,
    action,
    lowConfidence,
  }
}

interface Derived {
  isSending: boolean
  dayOfMonth: number
  daysLeft: number
  dailyCapacity: number
  lpt: number
  projectedMonthEnd: number
  paceRatio: number
  now: Date
}

/**
 * Pick the single binding constraint. Order matters: most-catastrophic and
 * fastest-to-fix first, so the top of the worklist is also the highest leverage.
 */
function classify(input: TriageInput, d: Derived): ReasonCode {
  // No target → can't score; own bucket.
  if (input.target <= 0) return 'NO_TARGET'

  // Warming up → don't punish for underperformance.
  if (input.warmupUntil) {
    const until = Date.parse(input.warmupUntil)
    if (!Number.isNaN(until) && d.now.getTime() < until) return 'WARMING_UP'
  }

  // Already hit target → ahead, leave alone (checked before pace so a met target
  // never reads as "behind" on a bad projection).
  if (input.deliveredMtd >= input.target) return 'AHEAD'

  // Projected to hit ≥ threshold → on track.
  if (d.paceRatio >= MISS_THRESHOLD) return 'ON_TRACK'

  // From here down the client is projected to MISS. Name why.

  // Emergency: not sending at all.
  if (!d.isSending) return 'NOT_SENDING'

  // Too early to trust a miss verdict on a sending client (but NOT_SENDING above
  // is always worth surfacing regardless of day).
  if (d.dayOfMonth < EARLY_MONTH_GATE) return 'TOO_EARLY'

  // Data runs out before month-end (can't fill remaining capacity with leads).
  const capacityDemand = d.dailyCapacity * d.daysLeft
  if (input.dataOnHand < capacityDemand) return 'NO_DATA'

  // Distinguish a capacity ceiling from a copy problem by asking: if this client
  // had a HEALTHY reply rate, would their mailboxes still be too few?
  //   - Yes  → genuinely NOT_ENOUGH_MAILBOXES (more infra is the fix).
  //   - No   → a healthy reply rate WOULD reach target, so the current shortfall
  //            is the reply rate / copy → LOW_REPLY_RATE.
  // Benchmarked against HEALTHY_LPT, not the client's current LPT (which is the
  // very thing under suspicion). Using current LPT here would make LOW_REPLY_RATE
  // unreachable — any low-LPT miss would always look capacity-capped.
  const maxLeadsAtHealthyLpt =
    input.deliveredMtd + capacityDemand * (HEALTHY_LPT / 1000)
  if (maxLeadsAtHealthyLpt < input.target) return 'NOT_ENOUGH_MAILBOXES'

  // Capacity + data could reach target at a healthy reply rate — so the binding
  // constraint is the current (too-low) reply efficiency.
  return 'LOW_REPLY_RATE'
}

function bucketFor(reason: ReasonCode): Bucket {
  switch (reason) {
    case 'NOT_SENDING':
    case 'NO_DATA':
      return 'needs_work'
    case 'NOT_ENOUGH_MAILBOXES':
    case 'LOW_REPLY_RATE':
      return 'structural'
    case 'ON_TRACK':
    case 'AHEAD':
      return 'leave_alone'
    default: // NO_TARGET, TOO_EARLY, WARMING_UP
      return 'unscored'
  }
}

export const REASON_LABEL: Record<ReasonCode, string> = {
  NOT_SENDING: 'Not sending',
  NO_DATA: 'Out of data',
  NOT_ENOUGH_MAILBOXES: 'Capacity-capped',
  LOW_REPLY_RATE: 'Low reply rate',
  ON_TRACK: 'On track',
  AHEAD: 'Ahead',
  NO_TARGET: 'No target',
  TOO_EARLY: 'Too early',
  WARMING_UP: 'Warming up',
}
