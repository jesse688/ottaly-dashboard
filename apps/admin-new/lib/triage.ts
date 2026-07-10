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
  replyRateNow: number | null // current reply rate % (workspace_stats.reply_rate_30d)
  replyRateBaseline: number | null // client's OWN trailing avg reply rate % (reply_rate_90d) — the bar to recover to
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
  workingDaysInMonth: number
  workingDaysElapsed: number
  workingDaysLeft: number
  expectedByNow: number // where they should be today (leads), working-day linear
  gap: number // leads behind pace (expectedByNow − deliveredMtd, ≥0)
  paceRatio: number // deliveredMtd / expectedByNow (<1 = behind pace)
  reason: ReasonCode
  bucket: Bucket
  priority: number
  action: string
  lowConfidence: boolean // reply-rate/LPT rests on thin data
  // Is the client's current reply rate meaningfully below their OWN trailing
  // average? If so the RR can demonstrably recover (they've hit it before) — a
  // recoverable LOW_REPLY_RATE the CM can quantify. (replyRateNow/Baseline are
  // inherited from TriageInput.)
  replyRateDropped: boolean
}

// Current RR counts as "dropped" when it's below this fraction of the client's
// own trailing baseline (e.g. 0.85 → now < 85% of their average). Tune to taste.
export const RR_DROP_RATIO = 0.85

// ── Tunables (from spec §2 decisions) ────────────────────────────────────────
export const MISS_THRESHOLD = 0.8 // actual pace < 80% of expected → needs work
export const SENDING_RECENCY_DAYS = 3 // sent within N days = actively sending
export const EARLY_MONTH_GATE = 5 // don't score before day N (noise)
export const DEFAULT_DAILY_PER_MAILBOX = 30 // fallback if capacity unknown
export const WORKING_DAYS_PER_MONTH = 22 // ~Mon–Fri days/month for capacity ceiling math
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

/**
 * Calendar + WORKING-DAY facts for the current month. `now` injected so callers
 * stay pure/testable. Cold email only sends Mon–Fri, so leads only arrive on
 * weekdays — pace is measured on working days, not calendar days, so a client
 * checked on a Monday isn't falsely shown behind for a weekend nothing sends on.
 */
export function monthClock(now: Date) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const dayOfMonth = now.getUTCDate()
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth)
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`

  // Count working days (Mon–Fri). getUTCDay(): 0=Sun … 6=Sat.
  let workingDaysInMonth = 0
  let workingDaysElapsed = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    const isWeekday = dow >= 1 && dow <= 5
    if (isWeekday) {
      workingDaysInMonth++
      if (d <= dayOfMonth) workingDaysElapsed++
    }
  }
  const workingDaysLeft = Math.max(0, workingDaysInMonth - workingDaysElapsed)

  return {
    daysInMonth,
    dayOfMonth,
    daysLeft,
    monthStart,
    workingDaysInMonth,
    workingDaysElapsed,
    workingDaysLeft,
  }
}

function isSendingNow(lastSentAt: string | null, now: Date): boolean {
  if (!lastSentAt) return false
  const last = Date.parse(lastSentAt)
  if (Number.isNaN(last)) return false
  const days = (now.getTime() - last) / 86_400_000
  return days <= SENDING_RECENCY_DAYS
}

/**
 * Core evaluation for one client. Scores on ACTUAL current-month pace (delivered
 * so far vs where they should be by today) — NOT on a forward projection. We
 * deliberately do not project month-end from capacity × efficiency: those
 * projections proved wildly optimistic (a client with 1 lead in 10 days but
 * healthy capacity/LPT projected to "hit target"). Real delivered leads are the
 * only trustworthy signal; the reason codes then explain WHY a client is behind.
 */
export function evaluate(input: TriageInput, now: Date): TriageResult {
  const { daysInMonth, dayOfMonth, daysLeft, workingDaysInMonth, workingDaysElapsed, workingDaysLeft } =
    monthClock(now)
  const isSending = isSendingNow(input.lastSentAt, now)

  // Capacity fallback: unknown/zero capacity → assume standard per-mailbox rate.
  // Still used by the reason codes (NO_DATA / NOT_ENOUGH_MAILBOXES), just not for
  // any projection of future leads.
  const dailyCapacity = input.dailyCapacity > 0 ? input.dailyCapacity : DEFAULT_DAILY_PER_MAILBOX

  // Actual linear pace on WORKING DAYS (leads only arrive Mon–Fri):
  //   expectedByNow = target × (workingDaysElapsed / workingDaysInMonth)
  //   paceRatio     = deliveredMtd / expectedByNow   (1.0 = exactly on pace)
  // No projection, no trusting future capacity — real delivered leads vs where
  // they should be by today. Example: target 30, 10 working days of 22 elapsed →
  // expected 13.6; 10 delivered → 74% (behind). Target 30, 10 leads early with
  // few days elapsed → over 100% (ahead).
  const expectedByNow =
    input.target > 0 && workingDaysInMonth > 0
      ? (input.target * workingDaysElapsed) / workingDaysInMonth
      : 0
  const paceRatio =
    input.target <= 0 ? 1 : expectedByNow > 0 ? input.deliveredMtd / expectedByNow : 1

  // Gap = leads behind where they should be by now (>0 = behind pace).
  const gap = Math.max(0, expectedByNow - input.deliveredMtd)

  const lpt = input.lpt ?? 0
  const lowConfidence = input.lpt == null || input.target <= 0

  // Reply-rate vs the client's OWN history: has it dropped below their baseline?
  // Proves the RR can recover (they've done better before) and gives the CM a
  // concrete "you were at X%, you're at Y% — get it back" target.
  const replyRateDropped =
    input.replyRateNow != null &&
    input.replyRateBaseline != null &&
    input.replyRateBaseline > 0 &&
    input.replyRateNow < input.replyRateBaseline * RR_DROP_RATIO

  const reason = classify(input, {
    isSending,
    dayOfMonth,
    workingDaysLeft,
    dailyCapacity,
    lpt,
    paceRatio,
    replyRateDropped,
    now,
  })
  const bucket = bucketFor(reason)
  // Concrete, recoverable RR message when we can show now-vs-baseline.
  const action =
    reason === 'LOW_REPLY_RATE' && replyRateDropped && input.replyRateNow != null && input.replyRateBaseline != null
      ? `Reply rate dropped to ${input.replyRateNow.toFixed(1)}% from a ${input.replyRateBaseline.toFixed(1)}% average — it can recover. Rework the copy / targeting.`
      : ACTIONS[reason]

  // Priority: how far below pace × how much target is at stake × how fixable.
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
    workingDaysInMonth,
    workingDaysElapsed,
    workingDaysLeft,
    expectedByNow,
    gap,
    paceRatio,
    reason,
    bucket,
    priority,
    action,
    lowConfidence,
    replyRateDropped,
  }
}

interface Derived {
  isSending: boolean
  dayOfMonth: number
  workingDaysLeft: number
  dailyCapacity: number
  lpt: number
  paceRatio: number
  replyRateDropped: boolean
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

  // Already at/over target for the month → ahead, leave alone.
  if (input.deliveredMtd >= input.target) return 'AHEAD'

  // On or above pace (delivered ≥ 80% of expected-by-today) → on track.
  if (d.paceRatio >= MISS_THRESHOLD) return 'ON_TRACK'

  // ── From here the client is BEHIND PACE. Diagnose WHY so the CM knows whether
  //    capacity is slipping or the reply rate is the problem. ──────────────────

  // Emergency: not sending at all (surfaced regardless of day-of-month).
  if (!d.isSending) return 'NOT_SENDING'

  // Too early in the month to trust a behind-pace verdict on a sending client.
  if (d.dayOfMonth < EARLY_MONTH_GATE) return 'TOO_EARLY'

  // Out of data: not enough sendable leads left to fill the remaining working
  // days at current capacity → sending WILL slip because there's nothing to send.
  const capacityDemand = d.dailyCapacity * d.workingDaysLeft
  if (input.dataOnHand < capacityDemand) return 'NO_DATA'

  // Reply rate has dropped below the client's OWN trailing average → decisive
  // evidence it's a reply-rate problem AND that it can recover (they've hit the
  // higher rate before). This beats the capacity check: even a capacity-tight
  // client with a fixable RR drop should be told to fix the RR first.
  if (d.replyRateDropped) return 'LOW_REPLY_RATE'

  // Otherwise separate "capacity slipping" from "reply rate low" structurally.
  // Ask: at a HEALTHY reply rate, is this client's sending capacity enough to hit
  // target for the month?
  //   - No  → capacity is the ceiling → NOT_ENOUGH_MAILBOXES (add mailboxes).
  //   - Yes → capacity is fine, so the shortfall is the reply rate → LOW_REPLY_RATE.
  // Benchmarked against HEALTHY_LPT, not the client's own (suspect) LPT.
  const monthlyCapacity = d.dailyCapacity * WORKING_DAYS_PER_MONTH
  const leadsAtHealthyReplyRate = monthlyCapacity * (HEALTHY_LPT / 1000)
  if (leadsAtHealthyReplyRate < input.target) return 'NOT_ENOUGH_MAILBOXES'

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
