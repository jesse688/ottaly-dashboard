import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'

// Finds APPROVED disputes that never credited a lead back.
//
// Before the sibling fix (#62), refundLead keyed its guard strictly on the
// disputed lead_id. Since charges are billed once per EMAIL (one of several
// duplicate esp_leads rows carries the lead_charge), disputing the uncharged
// sibling wrote no credit and reported success — LVM lost 2 leads that way.
//
// Read-only. Writes nothing, credits nothing: it tells you who is owed what so
// you can decide, then apply the adjustment by hand.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const res = await pool.query(`
    WITH d AS (
      SELECT dd.id, dd.lead_id, dd.client_id, dd.resolved_at, dd.created_at, dd.reason,
             -- Credits/charges live on the BILLING TARGET, not necessarily the
             -- disputing client (pooled clients like ButterflyEco SOP).
             COALESCE(pc.billing_client_id, pc.id) AS ledger_client_id,
             pc.company_name,
             pc.cost_per_lead,
             pc.charges_reset_at,
             l.email AS lead_email,
             l.first_name, l.last_name, l.company_name AS lead_company
        FROM portal_lead_disputes dd
        JOIN portal_clients pc ON pc.id = dd.client_id
        LEFT JOIN esp_leads l  ON l.id  = dd.lead_id
       WHERE dd.status = 'approved'
    )
    SELECT d.*,
           -- Was THIS exact row charged?
           EXISTS (
             SELECT 1 FROM portal_ledger pl
              WHERE pl.client_id = d.ledger_client_id
                AND pl.lead_id = d.lead_id AND pl.type = 'lead_charge'
           ) AS charged_exact,
           -- Was a SIBLING row (same email) charged? This is the bug case.
           EXISTS (
             SELECT 1 FROM portal_ledger pl
               JOIN esp_leads l2 ON l2.id = pl.lead_id
              WHERE pl.client_id = d.ledger_client_id
                AND pl.type = 'lead_charge'
                AND d.lead_email IS NOT NULL
                AND lower(l2.email) = lower(d.lead_email)
           ) AS charged_sibling,
           -- Any credit already given, on this row OR a same-email sibling?
           EXISTS (
             SELECT 1 FROM portal_ledger pl
               LEFT JOIN esp_leads l3 ON l3.id = pl.lead_id
              WHERE pl.client_id = d.ledger_client_id
                AND pl.type = 'dispute_refund'
                AND (pl.lead_id = d.lead_id
                     OR (d.lead_email IS NOT NULL AND lower(l3.email) = lower(d.lead_email)))
           ) AS refunded
      FROM d
     ORDER BY d.company_name ASC, d.resolved_at DESC NULLS LAST
  `)

  const rows = res.rows.map(r => {
    const charged = r.charged_exact === true || r.charged_sibling === true
    const refunded = r.refunded === true
    // Why was nothing credited?
    //   owed          — a charge exists but no credit: the sibling bug. REAL LOSS.
    //   never_charged — no charge anywhere, so nothing to reverse. Correct, not a
    //                   loss (delivered pre charges_reset_at, or cost_per_lead was 0).
    //   ok            — credit present, working as intended.
    const verdict: 'owed' | 'never_charged' | 'ok' =
      refunded ? 'ok' : charged ? 'owed' : 'never_charged'
    return {
      dispute_id: r.id as string,
      client_id: r.client_id as string,
      company_name: r.company_name as string,
      lead: [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.lead_email as string) || (r.lead_id as string),
      lead_email: (r.lead_email as string | null) ?? null,
      lead_company: (r.lead_company as string | null) ?? null,
      resolved_at: (r.resolved_at as string | null) ?? (r.created_at as string),
      cost_per_lead: Number(r.cost_per_lead ?? 0),
      // True when the charge sat on a duplicate row — the specific bug from #62.
      sibling_bug: r.charged_exact !== true && r.charged_sibling === true,
      verdict,
    }
  })

  const owed = rows.filter(r => r.verdict === 'owed')

  // Per-client totals: what to actually credit back, and what it's worth.
  const byClientMap = new Map<string, { client_id: string; company_name: string; leads: number; value: number; sibling_bug: number }>()
  for (const r of owed) {
    const e = byClientMap.get(r.client_id) ?? { client_id: r.client_id, company_name: r.company_name, leads: 0, value: 0, sibling_bug: 0 }
    e.leads += 1
    e.value += r.cost_per_lead
    if (r.sibling_bug) e.sibling_bug += 1
    byClientMap.set(r.client_id, e)
  }
  const byClient = [...byClientMap.values()].sort((a, b) => b.leads - a.leads || a.company_name.localeCompare(b.company_name))

  return NextResponse.json({
    summary: {
      approvedDisputes: rows.length,
      ok: rows.filter(r => r.verdict === 'ok').length,
      owed: owed.length,
      neverCharged: rows.filter(r => r.verdict === 'never_charged').length,
      siblingBug: owed.filter(r => r.sibling_bug).length,
      clientsAffected: byClient.length,
      leadsOwed: owed.length,
      valueOwed: owed.reduce((s, r) => s + r.cost_per_lead, 0),
    },
    byClient,
    // Everything, so a 'never_charged' verdict can be spot-checked rather than trusted.
    disputes: rows,
  })
}
