import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBalance, getLedger, reconcileLeadCharges } from '@/lib/balance'

// GET — lead-credit balance + outcome metrics + ledger.
// Spend & ROI are computed server-side and only included when the client's
// spend_visibility allows it, so hidden figures never reach the browser.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await reconcileLeadCharges(session.clientId)

    const [balance, ledgerAll, client, pipe] = await Promise.all([
      getBalance(session.clientId),
      getLedger(session.clientId, 500),
      pool.query('SELECT cost_per_lead, spend_visibility, low_leads_threshold FROM portal_clients WHERE id = $1', [session.clientId]),
      pool.query(
        `SELECT COALESCE(SUM(deal_value),0) AS pipeline,
                COUNT(*) FILTER (WHERE deal_value IS NOT NULL AND deal_value > 0) AS deals_won
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
      [session.clientId]
    )

    const spent = leadsDelivered * costPerLead
    const roiRaw = spent > 0 ? Math.round((pipeline - spent) / spent * 100) : null

    // Decide whether the client may see spend + ROI
    const showSpend = mode === 'always' || (mode === 'auto' && roiRaw !== null && roiRaw > 0)

    // Ledger: always safe to show as lead-count activity. Never leak £ from it.
    const ledger = ledgerAll.map(l => ({
      id: l.id, type: l.type, amount: Number(l.amount), description: l.description, created_at: l.created_at,
    }))

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
