import { NextResponse } from 'next/server'
import pool from '@/lib/db'

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
         mf.supplier AS supplier,
         mf.type     AS type,
         (ur.mailbox_email IS NOT NULL AND mf.email IS NOT NULL) AS matched
       FROM unibox_replies ur
       LEFT JOIN mailbox_full mf ON lower(mf.email) = lower(ur.mailbox_email)
       WHERE ur.marked_as_lead = TRUE ${windowClause}`,
      params
    )

    const bySupplier: Record<string, number> = {}
    const byType: Record<string, number> = {}
    const bySupplierType: Record<string, number> = {}
    let total = 0
    let matched = 0
    let unmatched = 0

    for (const r of res.rows) {
      total++
      if (!r.matched) { unmatched++; continue }
      matched++
      const sup = (r.supplier as string | null) || 'Unassigned'
      const typ = (r.type as string | null) || 'unknown'
      bySupplier[sup] = (bySupplier[sup] || 0) + 1
      byType[typ] = (byType[typ] || 0) + 1
      // Key matches the comparison table's group key: "Supplier · type".
      const stKey = `${sup} · ${typ}`
      bySupplierType[stKey] = (bySupplierType[stKey] || 0) + 1
    }

    return NextResponse.json({ days, total, matched, unmatched, bySupplier, byType, bySupplierType })
  } catch (err) {
    console.error('[mailboxes/leads]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
