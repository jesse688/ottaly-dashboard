import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { providerKey, supplierKey, tagKey, typeKeyTiered, type DimMailbox } from '@/lib/mailbox-dimensions'

export const dynamic = 'force-dynamic'

// GET /api/mailboxes/leads?days=30
//
// Billable leads (the ones that show in revenue) attributed to the supplier /
// provider-type of the mailbox that received the reply. A reply becomes a
// billable lead when it is marked in the client portal (unibox_replies.
// marked_as_lead). At intake we record unibox_replies.mailbox_email = the
// PlusVibe primary_to_email_address, i.e. OUR sending mailbox — so we can join
// straight to mailbox_full (email PK) to read that mailbox's supplier + type.
//
// Scope caveat surfaced to the UI: only portal-marked leads carry a mailbox.
// Pre-portal / directly-marked leads have no mailbox and are reported as
// `unmatched` rather than silently dropped.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    // days<=0 ⇒ all-time. Otherwise last N days by when the lead was MARKED
    // (marked_at), to line up with the "leads/revenue" mental model — not when
    // the reply first arrived.
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 0, 0), 365)
    const windowClause = days > 0 ? `AND ur.marked_at >= CURRENT_DATE - ($1::int - 1)` : ''
    const params = days > 0 ? [days] : []

    const res = await pool.query(
      `SELECT
         mf.email    AS email,
         mf.supplier AS supplier,
         mf.type     AS type,
         mf.tags     AS tags,
         (ur.mailbox_email IS NOT NULL AND mf.email IS NOT NULL) AS matched
       FROM unibox_replies ur
       LEFT JOIN mailbox_full mf ON lower(mf.email) = lower(ur.mailbox_email)
       WHERE ur.marked_as_lead = TRUE ${windowClause}`,
      params
    )

    // Bucket leads with the SAME functions the cards group by
    // (lib/mailbox-dimensions) so each card's Leads number lands on the card it
    // belongs to. This route used to keep its own copy of the google-tier rules,
    // which meant it emitted 'google generic'/'google new' under byType while
    // the provider cards asked for google/microsoft/smtp/azure — so those cards
    // showed no leads at all.
    const bySupplier: Record<string, number> = {}
    const byType: Record<string, number> = {}
    const byTag: Record<string, number> = {}
    const bySupplierType: Record<string, number> = {}
    let total = 0
    let matched = 0
    let unmatched = 0

    for (const r of res.rows) {
      total++
      if (!r.matched) { unmatched++; continue }
      matched++
      const m: DimMailbox = {
        email: (r.email as string | null) || '',
        type: r.type as string | null,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : null,
        supplier: r.supplier as string | null,
      }
      const sup = supplierKey(m)
      const prov = providerKey(m) || 'unknown'
      bySupplier[sup] = (bySupplier[sup] || 0) + 1
      byType[prov] = (byType[prov] || 0) + 1
      const tag = tagKey(m)
      byTag[tag] = (byTag[tag] || 0) + 1
      // Key matches the comparison table's group key: "Supplier · type", which
      // still uses the tiered google split.
      const stKey = `${sup} · ${typeKeyTiered(m) || 'unknown'}`
      bySupplierType[stKey] = (bySupplierType[stKey] || 0) + 1
    }

    return NextResponse.json({ days, total, matched, unmatched, bySupplier, byType, byTag, bySupplierType })
  } catch (err) {
    console.error('[mailboxes/leads]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
