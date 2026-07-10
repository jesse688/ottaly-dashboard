// Regression coverage for the CM Triage model (lib/triage.ts).
// No test framework is configured in this app, so this runs standalone:
//
//   npx tsx lib/triage.spec.mts
//
// Exits non-zero on any failure. Each scenario maps to a case in the original
// brief: a client sending-but-projected-to-miss must be flagged; a client
// out-of-data-but-ahead must be left alone; not-sending is an emergency.

import { evaluate, type TriageInput } from './triage.ts'

// Fixed "now": 2026-07-15 (day 15 of 31, 16 days left, past the early-month gate).
const NOW = new Date(Date.UTC(2026, 6, 15, 12, 0, 0))
const RECENT = new Date(Date.UTC(2026, 6, 14)).toISOString() // sent yesterday → sending
const STALE = new Date(Date.UTC(2026, 6, 1)).toISOString() // sent 14d ago → not sending

function base(over: Partial<TriageInput>): TriageInput {
  return {
    workspaceId: 'w', workspaceName: 'Test', managers: ['Alex'],
    target: 20, deliveredMtd: 5, lpt: 5, dailyCapacity: 200,
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

// A — sending fine, has data + mailboxes, but reply rate too low → LOW_REPLY_RATE.
{
  const r = evaluate(base({ lpt: 3, dataOnHand: 100_000, dailyCapacity: 200, deliveredMtd: 5 }), NOW)
  check('A LOW_REPLY_RATE', r.reason, 'LOW_REPLY_RATE')
  check('A structural', r.bucket, 'structural')
  check('A paceRatio<0.8', r.paceRatio < 0.8, true)
}
// B — out of data before month-end → NO_DATA.
{
  const r = evaluate(base({ dataOnHand: 500, lpt: 5 }), NOW)
  check('B NO_DATA', r.reason, 'NO_DATA')
  check('B needs_work', r.bucket, 'needs_work')
}
// C — not sending, behind target → NOT_SENDING (beats everything).
{
  const r = evaluate(base({ lastSentAt: STALE, deliveredMtd: 2 }), NOW)
  check('C NOT_SENDING', r.reason, 'NOT_SENDING')
  check('C needs_work', r.bucket, 'needs_work')
}
// D — out of data AND not sending, but already at target → AHEAD (leave alone).
{
  const r = evaluate(base({ deliveredMtd: 22, target: 20, dataOnHand: 0, lastSentAt: STALE }), NOW)
  check('D AHEAD', r.reason, 'AHEAD')
  check('D leave_alone', r.bucket, 'leave_alone')
  check('D priority 0', r.priority === 0, true)
}
// E — sending, plenty of data + reply rate → ON_TRACK.
{
  const r = evaluate(base({ lpt: 8, deliveredMtd: 5, dataOnHand: 100_000 }), NOW)
  check('E ON_TRACK', r.reason, 'ON_TRACK')
  check('E leave_alone', r.bucket, 'leave_alone')
}
// F — huge data, decent reply rate, too few mailboxes → NOT_ENOUGH_MAILBOXES.
{
  const r = evaluate(base({ dailyCapacity: 20, dataOnHand: 100_000, lpt: 5, deliveredMtd: 5 }), NOW)
  check('F NOT_ENOUGH_MAILBOXES', r.reason, 'NOT_ENOUGH_MAILBOXES')
  check('F structural', r.bucket, 'structural')
}
// G — no target → NO_TARGET / unscored.
{
  const r = evaluate(base({ target: 0 }), NOW)
  check('G NO_TARGET', r.reason, 'NO_TARGET')
  check('G unscored', r.bucket, 'unscored')
}
// H — bigger target miss outranks smaller (same reason).
{
  const big = evaluate(base({ target: 40, lpt: 1, deliveredMtd: 2 }), NOW)
  const small = evaluate(base({ target: 8, lpt: 1, deliveredMtd: 1 }), NOW)
  check('H big > small priority', big.priority > small.priority, true)
}
// I — early month → TOO_EARLY, don't cry miss on a sending client.
{
  const early = new Date(Date.UTC(2026, 6, 3, 12))
  const r = evaluate(base({ lpt: 1, deliveredMtd: 0 }), early)
  check('I TOO_EARLY', r.reason, 'TOO_EARLY')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
