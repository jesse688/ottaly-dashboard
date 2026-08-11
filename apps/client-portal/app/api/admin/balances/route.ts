import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// Balance summary across ALL clients — the at-a-glance view the per-client
// Settings modal can't give you.
//
// Deliberately a PURE READ: unlike every other balance path (see the callers of
// reconcileLeadCharges), this does NOT reconcile. Loading a summary of N clients
// must not fire billing for N clients as a side effect of opening a tab —
// lib/sync.ts already reconciles on the sync loop, so the numbers here are the
// same ones the client sees.
//
// One aggregate query, not N round-trips.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Balances live on the BILLING TARGET (portal_clients.billing_client_id), so a
  // redirected client (ButterflyEco SOP → ButterflyEco) has an empty ledger of its
  // own. Grouping the ledger by its raw client_id and joining on pc.id would show
  // those clients a hard 0 next to real balances. So: resolve each client to its
  // billing target first, then join the ledger totals onto THAT id — grouped
  // clients all report their shared pool.
  const res = await pool.query(`
    WITH totals AS (
      SELECT client_id,
             COALESCE(SUM(amount), 0)                                   AS balance,
             COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)          AS added,
             COUNT(*) FILTER (WHERE type = 'lead_charge')                AS delivered,
             MAX(created_at) FILTER (WHERE type = 'topup')               AS last_topup_at,
             MAX(created_at) FILTER (WHERE type = 'lead_charge')         AS last_charge_at
        FROM portal_ledger
       GROUP BY client_id
    ),
    pending AS (
      SELECT client_id, COALESCE(SUM(amount), 0) AS pending_leads, COUNT(*) AS pending_count
        FROM portal_topup_requests
       WHERE status = 'pending'
       GROUP BY client_id
    )
    SELECT pc.id,
           pc.company_name,
           pc.workspace_id,
           pc.active,
           pc.cost_per_lead,
           pc.currency,
           pc.low_leads_threshold,
           pc.billing_client_id,
           bc.company_name                       AS billing_company_name,
           COALESCE(t.balance, 0)                AS balance,
           COALESCE(t.added, 0)                  AS added,
           COALESCE(t.delivered, 0)              AS delivered,
           t.last_topup_at,
           t.last_charge_at,
           COALESCE(p.pending_leads, 0)          AS pending_leads,
           COALESCE(p.pending_count, 0)          AS pending_count
      FROM portal_clients pc
      LEFT JOIN portal_clients bc ON bc.id = pc.billing_client_id
      -- join on the BILLING TARGET, not pc.id
      LEFT JOIN totals  t ON t.client_id  = COALESCE(pc.billing_client_id, pc.id)
      -- pending top-ups are requested BY the client, so they stay keyed on pc.id
      LEFT JOIN pending p ON p.client_id  = pc.id
     ORDER BY pc.company_name ASC
  `)

  // Mirrors lib/balance.ts:6-7 — pay-per-lead clients are billed per delivered
  // lead, never pre-pay, never lock. They have no meaningful "balance" and must
  // not be flagged as empty. Kept in sync by hand (see the note in balance.ts).
  const PAY_PER_LEAD_WORKSPACES = new Set(['6a0e29d0d004be93be3f33f2'])
  const PAY_PER_LEAD_COMPANIES = new Set(['bubble'])

  const clients = res.rows.map(r => {
    const balance = Number(r.balance)
    const costPerLead = Number(r.cost_per_lead ?? 0)
    const threshold = Number(r.low_leads_threshold ?? 5)
    const payPerLead =
      PAY_PER_LEAD_WORKSPACES.has(String(r.workspace_id ?? '').trim().toLowerCase()) ||
      PAY_PER_LEAD_COMPANIES.has(String(r.company_name ?? '').trim().toLowerCase())

    // Status drives the whole page. Order matters — first match wins.
    //   not_billed  cost_per_lead <= 0, so reconcileLeadCharges is a no-op for
    //               this client and the balance is meaningless, not "empty".
    //   pay_per_lead billed per lead, never runs out.
    //   negative    already delivering leads past a zero balance — leads are LOCKED.
    //   empty       exactly 0 left.
    //   low         at or under their own low_leads_threshold.
    let status: 'ok' | 'low' | 'empty' | 'negative' | 'not_billed' | 'pay_per_lead'
    if (payPerLead)             status = 'pay_per_lead'
    else if (costPerLead <= 0)  status = 'not_billed'
    else if (balance < 0)       status = 'negative'
    else if (balance === 0)     status = 'empty'
    else if (balance <= threshold) status = 'low'
    else                        status = 'ok'

    return {
      id: r.id as string,
      company_name: r.company_name as string,
      active: r.active as boolean,
      cost_per_lead: costPerLead,
      currency: (r.currency as string) ?? 'GBP',
      low_leads_threshold: threshold,
      // Surfaced so the UI can say "pooled with X" rather than showing a number
      // that looks like it belongs to this client alone.
      billing_company_name: (r.billing_company_name as string | null) ?? null,
      balance,
      added: Number(r.added),
      delivered: Number(r.delivered),
      // £ value of what's left, for the "money sitting on account" total.
      value: balance > 0 ? balance * costPerLead : 0,
      last_topup_at: r.last_topup_at as string | null,
      last_charge_at: r.last_charge_at as string | null,
      pending_leads: Number(r.pending_leads),
      pending_count: Number(r.pending_count),
      status,
    }
  })

  // Totals cover only clients whose balance is real and billable — including
  // not_billed/pay_per_lead clients would inflate "leads on account" with zeros
  // and non-balances. Redirected clients are excluded from the sums too, since
  // their balance is a duplicate view of the target's pool.
  const counted = clients.filter(
    c => c.active && c.status !== 'not_billed' && c.status !== 'pay_per_lead' && !c.billing_company_name
  )

  return NextResponse.json({
    clients,
    summary: {
      clients: counted.length,
      leads: counted.reduce((s, c) => s + c.balance, 0),
      value: counted.reduce((s, c) => s + c.value, 0),
      needsAttention: counted.filter(c => c.status !== 'ok').length,
      negative: counted.filter(c => c.status === 'negative').length,
      empty: counted.filter(c => c.status === 'empty').length,
      low: counted.filter(c => c.status === 'low').length,
      pendingTopups: clients.reduce((s, c) => s + c.pending_count, 0),
    },
  })
}
