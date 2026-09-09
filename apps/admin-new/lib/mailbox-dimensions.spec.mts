// Regression coverage for mailbox bucketing (lib/mailbox-dimensions.ts).
// No test framework is configured in this app, so this runs standalone:
//
//   npx tsx lib/mailbox-dimensions.spec.mts
//
// These assertions exist because the card COUNTS and the card STATS were
// bucketed by two independent copies of this logic, and they drifted. A key
// that only one side produces renders as an em dash forever, silently. So the
// contract under test is: every key these functions produce is a key the cards
// actually render, and nothing else.

import { keyFor, providerKey, supplierKey, tagKey, typeKeyTiered, DIMENSIONS, type DimMailbox } from './mailbox-dimensions.ts'

let failures = 0
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return
  failures++
  console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`)
}

const mb = (over: Partial<DimMailbox>): DimMailbox =>
  ({ email: 'a@example.com', type: 'google', tags: null, supplier: null, ...over })

// ── provider dimension ───────────────────────────────────────────────────────
// The cards render exactly these four keys. Anything else is invisible.
const PROVIDER_CARDS = new Set(['google', 'microsoft', 'smtp', 'azure'])

eq(providerKey(mb({ type: 'google' })), 'google', 'google stays google')
eq(providerKey(mb({ type: 'smtp' })), 'smtp', 'smtp stays smtp')
eq(providerKey(mb({ type: 'microsoft' })), 'microsoft', 'plain microsoft')

// The azure split: the five Inboxing.com domains are microsoft mailboxes on a
// different supply route. The writer had no azure concept, so their sends were
// counted inside microsoft and the azure card had nothing to read.
eq(providerKey(mb({ type: 'microsoft', email: 'j@ottalyuk.co.uk' })), 'azure', 'azure domain → azure')
eq(providerKey(mb({ type: 'microsoft', email: 'j@LVMGroupUK.co.uk' })), 'azure', 'azure match is case-insensitive')
eq(providerKey(mb({ type: 'microsoft', email: 'j@notazure.co.uk' })), 'microsoft', 'other domain stays microsoft')
// Only microsoft mailboxes can be azure — a google box on an azure domain is
// still google.
eq(providerKey(mb({ type: 'google', email: 'j@ottalyuk.co.uk' })), 'google', 'azure domain does not override google')

// The provider dimension must NOT split google into tiers. It used to, and
// those rows had no card to display them.
eq(providerKey(mb({ type: 'google', tags: ['Google Generic'] })), 'google', 'provider does not tier google (generic)')
eq(providerKey(mb({ type: 'google', tags: ['Google New Sep'] })), 'google', 'provider does not tier google (new)')

for (const t of ['google', 'microsoft', 'smtp']) {
  const k = providerKey(mb({ type: t }))
  eq(PROVIDER_CARDS.has(k!), true, `provider key '${k}' has a card`)
}
eq(providerKey(mb({ type: null })), null, 'no type → no provider bucket')

// ── tag dimension ────────────────────────────────────────────────────────────
eq(tagKey(mb({ tags: ['Google Generic'] })), 'Google Generic', 'tag: google generic')
eq(tagKey(mb({ tags: ['Google New Sep'] })), 'Google New Sep', 'tag: google new')
eq(tagKey(mb({ tags: ['Google Legacy'] })), 'Google Legacy', 'tag: google legacy')
eq(tagKey(mb({ tags: ['MS New Sep'] })), 'MS New Sep', 'tag: ms new')
eq(tagKey(mb({ tags: ['MS Legacy'] })), 'MS Legacy', 'tag: ms legacy')

// Fuzzy matching: normalised to lowercase alphanumerics, all words required.
eq(tagKey(mb({ tags: ['google-generic'] })), 'Google Generic', 'tag: punctuation ignored')
eq(tagKey(mb({ tags: ['GoogleNewSep'] })), 'Google New Sep', 'tag: no separators')
eq(tagKey(mb({ tags: ['new google'] })), 'Google New Sep', 'tag: word order ignored')
// "MS New SEP" has no 'google', so it must not match a google rule.
eq(tagKey(mb({ tags: ['MS New Sep'] })), 'MS New Sep', 'tag: ms new does not match google new')

// Order matters: 'inboxing' wins because those mailboxes also carry client tags.
eq(tagKey(mb({ tags: ['Acme Corp', 'Inboxing.com'] })), 'Inboxing.com', 'tag: inboxing wins over other tags')
eq(tagKey(mb({ tags: ['Inboxing.com', 'Google Generic'] })), 'Inboxing.com', 'tag: inboxing checked first')
// 'generic' is checked before the legacy fallbacks.
eq(tagKey(mb({ tags: ['Google Generic', 'Google Legacy'] })), 'Google Generic', 'tag: generic before legacy')

// Untagged is a real bucket, not a drop — the tag cards must sum to the fleet.
eq(tagKey(mb({ tags: null })), 'Untagged', 'tag: null tags → Untagged')
eq(tagKey(mb({ tags: [] })), 'Untagged', 'tag: empty tags → Untagged')
eq(tagKey(mb({ tags: ['Some Client'] })), 'Untagged', 'tag: unmatched tag → Untagged')

// ── supplier dimension ───────────────────────────────────────────────────────
eq(supplierKey(mb({ supplier: 'Mithun' })), 'Mithun', 'supplier passes through')
eq(supplierKey(mb({ supplier: null })), 'Unassigned', 'no supplier → Unassigned')

// ── tiered type (comparison table only) ──────────────────────────────────────
eq(typeKeyTiered(mb({ type: 'google', tags: ['Google Generic'] })), 'google generic', 'tiered: generic')
eq(typeKeyTiered(mb({ type: 'google', tags: ['Google New Sep'] })), 'google new', 'tiered: new')
eq(typeKeyTiered(mb({ type: 'google', tags: null })), 'google', 'tiered: untagged google stays google')
eq(typeKeyTiered(mb({ type: 'microsoft' })), 'microsoft', 'tiered: non-google untouched')

// ── keyFor dispatch ──────────────────────────────────────────────────────────
// The writer loops over DIMENSIONS and calls keyFor, so these must agree with
// the per-dimension functions the API route groups by.
const sample = mb({ type: 'microsoft', email: 'j@ottalyuk.co.uk', tags: ['Inboxing.com'], supplier: 'Inboxing' })
eq(keyFor('supplier', sample), supplierKey(sample), 'keyFor supplier matches supplierKey')
eq(keyFor('type', sample), providerKey(sample), 'keyFor type matches providerKey')
eq(keyFor('tag', sample), tagKey(sample), 'keyFor tag matches tagKey')
eq([...DIMENSIONS], ['supplier', 'type', 'tag'], 'DIMENSIONS covers all three card rows')

if (failures) { console.error(`\n${failures} failing assertion(s)`); process.exit(1) }
console.log('mailbox-dimensions: all assertions passed')
