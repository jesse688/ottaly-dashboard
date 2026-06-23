import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBalance, getLedger, reconcileLeadCharges, billingClientId } from '@/lib/balance'

// GET — lead-credit balance + outcome metrics + ledger.
// Spend & ROI are computed server-side and only included when the client's
// spend_visibility allows it, so hidden figures never reach the browser.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await reconcileLeadCharges(session.clientId)
    const billingId = await billingClientId(session.clientId)

    const [balance, ledgerAll, client, pipe] = await Promise.all([
      getBalance(session.clientId),
      getLedger(session.clientId, 500),
      pool.query('SELECT cost_per_lead, spend_visibility, low_leads_threshold FROM portal_clients WHERE id = $1', [session.clientId]),
      // "Deals won" = leads the client moved to a deal stage named "Won" (their
      // client_label), NOT leads with a deal_value. deal_value is no longer shown
      // to clients, so it can't be the signal. Match the 'Won' stage label
      // case-insensitively. pipeline still sums deal_value (server-side only;
      // only surfaced behind showSpend, never as a deal-value figure to the client).
      pool.query(
        `SELECT COALESCE(SUM(deal_value),0) AS pipeline,
                COUNT(*) FILTER (WHERE lower(trim(client_label)) = 'won') AS deals_won
           FROM portal_lead_data WHERE client_id = $1`,
        [session.clientId]
      ),
    ])

    const costPerLead = Number(client.rows[0]?.cost_per_lead ?? 0)
    const mode: string = client.rows[0]?.spend_visibility ?? 'auto'
    const lowThreshold = Number(client.rows[0]?.low_leads_threshold ?? 5)
    const pipeline = Number(pipe.rows[0]?.pipeline ?? 0)
    const dealsWon = Number(pipe.rows[0]?.deals_won ?? 0)
    const leadsDelivered = ledgerAll.filter(l => l.type === 'lead_charge').length

    // Server-side added/used totals (the ledger sent to the client is capped).
    const tot = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS added,
              ABS(COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0)) AS used
         FROM portal_ledger WHERE client_id = $1`,
      [billingId]
    )

    const spent = leadsDelivered * costPerLead
    const roiRaw = spent > 0 ? Math.round((pipeline - spent) / spent * 100) : null

    // Decide whether the client may see spend + ROI
    const showSpend = mode === 'always' || (mode === 'auto' && roiRaw !== null && roiRaw > 0)

    // Ledger: always safe to show as lead-count activity. Never leak £ from it.
    // Compute the running balance AFTER each row. getLedger returns newest→oldest;
    // the newest row's balance_after is the TRUE current balance (getBalance),
    // which also makes this correct even when the list is capped at 500 rows
    // (we anchor at the top and walk down, subtracting each row's delta).
    // Manual admin adjustments (type 'adjustment'/'set') must NOT be visible to
    // the client — but they DO affect the balance. So we walk EVERY row to keep
    // the running balance correct, then only EXPOSE topup / lead_charge /
    // dispute_refund rows (adding leads, lead delivered, non-lead credited).
    const HIDDEN_TYPES = new Set(['adjustment', 'set'])
    let running = balance
    const ledger: Array<{ id: string; type: string; amount: number; description: string | null; created_at: string; balance_after: number }> = []
    for (const l of ledgerAll) {
      const amount = Number(l.amount)
      const balance_after = running
      running -= amount
      if (HIDDEN_TYPES.has(l.type)) continue
      ledger.push({ id: l.id, type: l.type, amount, description: l.description, created_at: l.created_at, balance_after })
    }

    return NextResponse.json({
      balance,                 // leads left (always)
      added: Number(tot.rows[0]?.added ?? 0),
      used: Number(tot.rows[0]?.used ?? 0),
      lowThreshold,            // warn "Low on leads" at/below this (always)
      leadsDelivered,          // always (positive framing)
      pipeline,                // always (positive)
      dealsWon,                // always (positive)
      ledger,                  // lead-unit activity (always)
      showSpend,               // gate flag
      // money figures only when allowed:
      ...(showSpend ? { spent, roi: roiRaw, costPerLead } : {}),
    })
  } catch (err) {
    console.error('[portal/balance]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
