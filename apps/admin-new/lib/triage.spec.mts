// Regression coverage for the CM Triage model (lib/triage.ts).
// No test framework is configured in this app, so this runs standalone:
//
//   npx tsx lib/triage.spec.mts
//
// The model scores on ACTUAL working-day pace (delivered vs expected-by-today),
// NOT on a forward projection — projections proved unreliable (a client with 1
// lead in 10 days but healthy capacity projected to "hit target"). Reason codes
// then explain WHY a behind client is behind: not sending / out of data /
// capacity too small / reply rate low.

import { evaluate, monthClock, type TriageInput } from './triage.ts'

// Fixed "now": 2026-07-15. July 2026: 1st is a Wed. Working days = 23; by the
// 15th, 11 working days elapsed (Wed–Fri wk1=3, +5, +3 up to Wed 15th).
const NOW = new Date(Date.UTC(2026, 6, 15, 12, 0, 0))
const RECENT = new Date(Date.UTC(2026, 6, 14)).toISOString() // sent yesterday → sending
const STALE = new Date(Date.UTC(2026, 6, 1)).toISOString() // sent 14d ago → not sending

function base(over: Partial<TriageInput>): TriageInput {
  return {
    workspaceId: 'w', workspaceName: 'Test', managers: ['Alex'],
    target: 20, deliveredMtd: 5, lpt: 5, dailyCapacity: 200,
    replyRateNow: 1.0, replyRateBaseline: 1.0,
    dataOnHand: 100_000, lastSentAt: RECENT, clientStatus: 'active',
    pricePerLead: null, warmupUntil: null,
    ...over,
  }
}

let pass = 0, fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

// Sanity: working-day clock. July 2026 has 23 weekdays; 11 elapsed by the 15th.
{
  const c = monthClock(NOW)
  check('clock workingDaysInMonth', c.workingDaysInMonth, 23)
  check('clock workingDaysElapsed', c.workingDaysElapsed, 11)
}

// THE BUG THAT PROMPTED THIS: Jumping Spider — 1 lead by mid-month, target 12.
// expected = 12 × 11/23 = 5.7; pace = 1/5.7 = 17% → must be BEHIND, not green.
{
  const r = evaluate(base({ target: 12, deliveredMtd: 1, lpt: 5, dataOnHand: 30_000 }), NOW)
  check('JS behind pace (<0.8)', r.paceRatio < 0.8, true)
  check('JS not leave_alone', r.bucket !== 'leave_alone', true)
}

// User's on-track example: target 30, 10 leads, ~mid-month.
// expected = 30 × 11/23 = 14.3; 10/14.3 = 70% → still a bit behind (as it should
// be — 10 of 30 by 48% of working days is under linear pace). At 15 it'd be ~on.
{
  const r = evaluate(base({ target: 30, deliveredMtd: 15, dataOnHand: 50_000, lpt: 8 }), NOW)
  check('30-target on-pace ON_TRACK', r.reason, 'ON_TRACK')
  check('30-target leave_alone', r.bucket, 'leave_alone')
}

// A — behind pace, sending, data + mailboxes fine → LOW_REPLY_RATE.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 2, dataOnHand: 100_000, dailyCapacity: 200 }), NOW)
  check('A LOW_REPLY_RATE', r.reason, 'LOW_REPLY_RATE')
  check('A structural', r.bucket, 'structural')
  check('A paceRatio<0.8', r.paceRatio < 0.8, true)
}
// B — behind pace, out of data → NO_DATA.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 2, dataOnHand: 200 }), NOW)
  check('B NO_DATA', r.reason, 'NO_DATA')
  check('B needs_work', r.bucket, 'needs_work')
}
// C — behind pace, not sending → NOT_SENDING.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 2, lastSentAt: STALE }), NOW)
  check('C NOT_SENDING', r.reason, 'NOT_SENDING')
  check('C needs_work', r.bucket, 'needs_work')
}
// D — already at target → AHEAD (leave alone) even if not sending / no data.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 22, dataOnHand: 0, lastSentAt: STALE }), NOW)
  check('D AHEAD', r.reason, 'AHEAD')
  check('D leave_alone', r.bucket, 'leave_alone')
  check('D priority 0', r.priority === 0, true)
}
// E — on pace → ON_TRACK.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 12, dataOnHand: 100_000 }), NOW)
  check('E ON_TRACK', r.reason, 'ON_TRACK')
  check('E leave_alone', r.bucket, 'leave_alone')
}
// F — behind pace, huge data + reply rate, too few mailboxes → NOT_ENOUGH_MAILBOXES.
// dailyCapacity 20 → monthly 20×22=440 sends; at HEALTHY_LPT 20 → 8.8 leads < target 20.
{
  const r = evaluate(base({ target: 20, deliveredMtd: 2, dailyCapacity: 20, dataOnHand: 100_000 }), NOW)
  check('F NOT_ENOUGH_MAILBOXES', r.reason, 'NOT_ENOUGH_MAILBOXES')
  check('F structural', r.bucket, 'structural')
}
// J — YOUR RR-HISTORY CASE: reply rate dropped from 1.2% avg to 0.8% now →
// LOW_REPLY_RATE (recoverable), even on a capacity-tight client. Action names the
// numbers so the CM knows the RR can come back.
{
  const r = evaluate(base({
    target: 20, deliveredMtd: 2, dailyCapacity: 20, // capacity-tight
    replyRateNow: 0.8, replyRateBaseline: 1.2,       // dropped below own average
  }), NOW)
  check('J replyRateDropped', r.replyRateDropped, true)
  check('J LOW_REPLY_RATE (beats capacity)', r.reason, 'LOW_REPLY_RATE')
  check('J action names numbers', /0\.8% from a 1\.2%/.test(r.action), true)
}
// J2 — RR steady at baseline → NOT flagged as dropped; capacity-tight → capacity.
{
  const r = evaluate(base({
    target: 20, deliveredMtd: 2, dailyCapacity: 20,
    replyRateNow: 1.2, replyRateBaseline: 1.2, // steady, not dropped
  }), NOW)
  check('J2 not dropped', r.replyRateDropped, false)
  check('J2 NOT_ENOUGH_MAILBOXES', r.reason, 'NOT_ENOUGH_MAILBOXES')
}

// G — no target → NO_TARGET / unscored.
{
  const r = evaluate(base({ target: 0 }), NOW)
  check('G NO_TARGET', r.reason, 'NO_TARGET')
  check('G unscored', r.bucket, 'unscored')
}
// H — bigger target behind outranks smaller (same reason).
{
  const big = evaluate(base({ target: 40, deliveredMtd: 2, dailyCapacity: 20 }), NOW)
  const small = evaluate(base({ target: 8, deliveredMtd: 1, dailyCapacity: 20 }), NOW)
  check('H big > small priority', big.priority > small.priority, true)
}
// I — early month → TOO_EARLY on a sending, behind client.
{
  const early = new Date(Date.UTC(2026, 6, 2, 12)) // 2nd, before day-5 gate
  const r = evaluate(base({ target: 20, deliveredMtd: 0 }), early)
  check('I TOO_EARLY', r.reason, 'TOO_EARLY')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
