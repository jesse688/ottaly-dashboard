import pool from './db'

// The lead-credit balance is the signed sum of all ledger rows:
//   topup (+) · dispute_refund (+) · adjustment (+/-) · lead_charge (-)
export async function getBalance(clientId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM portal_ledger WHERE client_id = $1`,
    [clientId]
  )
  return Number(r.rows[0]?.balance ?? 0)
}

export async function getLedger(clientId: string, limit = 100) {
  const r = await pool.query(
    `SELECT id, type, amount, lead_id, description, created_by, created_at
       FROM portal_ledger WHERE client_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [clientId, limit]
  )
  return r.rows
}

// Ensure exactly one lead_charge exists per delivered (INTERESTED) lead for this
// client. Idempotent via uq_ledger_lead_charge. No-op when cost_per_lead = 0.
// Returns number of new charges created.
export async function reconcileLeadCharges(clientId: string): Promise<number> {
  const c = await pool.query(
    `SELECT workspace_id, cost_per_lead FROM portal_clients WHERE id = $1`,
    [clientId]
  )
  const row = c.rows[0]
  if (!row) return 0
  const cost = Number(row.cost_per_lead ?? 0)
  if (cost <= 0) return 0

  // Insert a -cost charge for every INTERESTED plusvibe lead in the workspace
  // that doesn't already have one. ON CONFLICT keeps it idempotent.
  const res = await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     SELECT $1, 'lead_charge', $2, l.id,
            'Lead delivered: ' || COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') ||
            CASE WHEN l.company_name IS NOT NULL THEN ' (' || l.company_name || ')' ELSE '' END,
            'system'
       FROM esp_leads l
      WHERE l.workspace_id = $3
        AND l.source = 'plusvibe'
        AND l.label = 'INTERESTED'
        AND NOT EXISTS (
          SELECT 1 FROM portal_ledger pl
           WHERE pl.client_id = $1 AND pl.lead_id = l.id AND pl.type = 'lead_charge'
        )
     ON CONFLICT (client_id, lead_id) WHERE type = 'lead_charge' DO NOTHING`,
    [clientId, -cost, row.workspace_id]
  )
  return res.rowCount ?? 0
}

// Credit the cost back when a non-lead dispute is approved. Idempotent.
export async function refundLead(clientId: string, leadId: string): Promise<void> {
  const c = await pool.query(`SELECT cost_per_lead FROM portal_clients WHERE id = $1`, [clientId])
  const cost = Number(c.rows[0]?.cost_per_lead ?? 0)
  if (cost <= 0) return
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     VALUES ($1, 'dispute_refund', $2, $3, 'Refund: non-lead approved', 'admin')
     ON CONFLICT (client_id, lead_id) WHERE type = 'dispute_refund' DO NOTHING`,
    [clientId, cost, leadId]
  )
}

export async function addTopup(clientId: string, amount: number, note?: string): Promise<void> {
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'topup', $2, $3, 'admin')`,
    [clientId, Math.abs(amount), note ?? 'Top-up']
  )
}

export async function addAdjustment(clientId: string, amount: number, note: string): Promise<void> {
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'adjustment', $2, $3, 'admin')`,
    [clientId, amount, note]
  )
}
