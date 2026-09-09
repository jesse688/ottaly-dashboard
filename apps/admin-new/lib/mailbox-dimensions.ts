// Single source of truth for how a mailbox is bucketed into the three
// dimensions the Supplier Performance cards are grouped by: supplier, provider
// and tag.
//
// WHY THIS FILE EXISTS: the card COUNTS come from /api/mailboxes (grouped live
// from mailbox_full) while the card STATS come from mailbox_supplier_daily
// (written by lib/mailbox-sync.ts). Those two used to bucket independently, and
// they drifted:
//
//   - the writer had no 'azure' concept, so the azure card had no rows to read
//     and its sends were counted inside microsoft;
//   - the writer split google into 'google generic' / 'google new' under the
//     provider dimension, but the cards stopped asking for those keys, so those
//     rows were stranded with nothing to display them;
//   - the tag dimension was never written at all.
//
// A key that only one side knows about renders as an em dash forever, and it
// fails silently — the card looks like a mailbox that sends nothing. So both
// sides MUST import from here. Do not re-derive a bucket anywhere else.

// A mailbox needs only these fields to be bucketed.
export interface DimMailbox {
  email: string
  type: string | null
  tags: string[] | null
  supplier: string | null
}

// Tags are free text typed by hand in PlusVibe, so compare them normalized:
// lowercase, letters and digits only. "Google New Sep", "google-new-sep" and
// "GoogleNewSep" all reduce to the same token.
export const normTag = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Azure = the five Inboxing.com domains. They are microsoft mailboxes but a
// different supply route, so the provider dimension counts them separately.
export const AZURE_DOMAINS = new Set([
  'lvmgroupuk.co.uk',
  'hawthorneenergypartners.co.uk',
  'firstvehicleteam.co.uk',
  'butterflyeco-greenenergy.co.uk',
  'ottalyuk.co.uk',
])

const domainOf = (email: string) => (email.split('@')[1] || '').toLowerCase()

// Tag dimension. Each mailbox lands in exactly ONE bucket, first match wins, so
// the cards add up to the fleet. Fuzzy match: normalise the tag then require ALL
// the rule's words, so "Google New Sep", "New Google" and "GoogleNewSep" all
// match while "MS New SEP" (no 'google') does not. Order matters — 'generic' is
// checked before the legacy fallbacks. 'inboxing' goes first: those mailboxes
// also carry client tags, and this is the one that says where they came from.
export const TAG_RULES: { needs: string[]; key: string }[] = [
  { needs: ['inboxing'], key: 'Inboxing.com' },
  { needs: ['google', 'generic'], key: 'Google Generic' },
  { needs: ['google', 'new'], key: 'Google New Sep' },
  { needs: ['google', 'legacy'], key: 'Google Legacy' },
  { needs: ['ms', 'new'], key: 'MS New Sep' },
  { needs: ['ms', 'legacy'], key: 'MS Legacy' },
]

// Which tag bucket does this mailbox fall in? Untagged mailboxes get their own
// card rather than being dropped, so the tag cards still sum to the fleet.
export function tagKey(m: DimMailbox): string {
  if (!Array.isArray(m.tags)) return 'Untagged'
  const norm = m.tags.map(normTag)
  const hit = TAG_RULES.find(rule => norm.some(t => rule.needs.every(w => t.includes(w))))
  return hit ? hit.key : 'Untagged'
}

// Provider dimension: google / smtp / azure / microsoft — nothing else. Google
// tiers (generic / new) are a TAG concern and live in the tag dimension rather
// than splitting this one.
export function providerKey(m: DimMailbox): string | null {
  if (m.type === 'microsoft') return AZURE_DOMAINS.has(domainOf(m.email)) ? 'azure' : 'microsoft'
  return m.type || null
}

// Supplier dimension. Unassigned is a real bucket, not a skip.
export function supplierKey(m: DimMailbox): string {
  return m.supplier || 'Unassigned'
}

// The google tier split, kept for the supplier × type comparison table which
// still wants it. NOT used by the provider cards.
export function typeKeyTiered(m: DimMailbox): string | null {
  if (m.type !== 'google') return m.type || null
  const b = tagKey(m)
  return b === 'Google Generic' ? 'google generic' : b === 'Google New Sep' ? 'google new' : m.type
}

// The dimension names written to / read from mailbox_supplier_daily. The reader
// validates against this list so a typo in a query string can't silently return
// an empty series.
export const DIMENSIONS = ['supplier', 'type', 'tag'] as const
export type Dimension = (typeof DIMENSIONS)[number]

// Bucket a mailbox for one dimension. This is the function both the writer and
// the API route go through, so a key can never exist on only one side.
export function keyFor(dimension: Dimension, m: DimMailbox): string | null {
  switch (dimension) {
    case 'supplier': return supplierKey(m)
    case 'type': return providerKey(m)
    case 'tag': return tagKey(m)
  }
}
