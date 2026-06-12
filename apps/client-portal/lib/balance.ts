import pool from './db'

// The lead balance is a COUNT OF LEADS (not money). Signed sum of ledger rows:
//   topup (+N leads) · dispute_refund (+1) · adjustment (+/-) · lead_charge (-1)
// cost_per_lead (£) is only used to value top-ups / show £ alongside — never the unit.
export async function getBalance(clientId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM portal_ledger WHERE client_id = $1`,
    [clientId]
  )
  return Number(r.rows[0]?.balance ?? 0)
}

// Leads delivered while the client is out of credit are "locked" — shown as a
// teaser (name only) with contact details + conversation hidden until a top-up
// is paid. Locking is DERIVED from the ledger, not stored: the newest
// (delivered − creditsGranted) charged leads are locked, so a paid top-up
// automatically unlocks the oldest locked leads, up to the amount paid.
export async function getLockedLeadIds(clientId: string): Promise<Set<string>> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type <> 'lead_charge'), 0) AS credits,
            COUNT(*) FILTER (WHERE type = 'lead_charge')                  AS delivered
       FROM portal_ledger WHERE client_id = $1`,
    [clientId]
  )
  const credits = Number(r.rows[0]?.credits ?? 0)
  const delivered = Number(r.rows[0]?.delivered ?? 0)
  const lockedCount = Math.max(0, delivered - credits)
  if (lockedCount === 0) return new Set<string>()

  // Lock the NEWEST-delivered leads, ordered by the same real-world delivery key
  // the client list sorts on (first_replied_at, then created_at) — NOT the ledger
  // row insert time, which can differ. lead id is a stable tiebreaker so the locked
  // set is deterministic across refreshes even when timestamps tie.
  const locked = await pool.query(
    `SELECT pl.lead_id
       FROM portal_ledger pl
       JOIN esp_leads l ON l.id = pl.lead_id
      WHERE pl.client_id = $1 AND pl.type = 'lead_charge' AND pl.lead_id IS NOT NULL
      ORDER BY COALESCE(l.first_replied_at, l.created_at) DESC NULLS LAST, l.id DESC
      LIMIT $2`,
    [clientId, lockedCount]
  )
  return new Set<string>(locked.rows.map(x => x.lead_id as string))
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

// Ensure exactly one lead_charge (-1 lead) exists per delivered (INTERESTED) lead
// for this client. Idempotent via uq_ledger_lead_charge. Gated by cost_per_lead>0,
// i.e. the lead balance only counts down once you've set up pricing for the client.
// Returns number of new charges created.
export async function reconcileLeadCharges(clientId: string): Promise<number> {
  const c = await pool.query(
    `SELECT workspace_id, cost_per_lead, charges_reset_at FROM portal_clients WHERE id = $1`,
    [clientId]
  )
  const row = c.rows[0]
  if (!row) return 0
  if (Number(row.cost_per_lead ?? 0) <= 0) return 0

  // -1 lead for every INTERESTED lead in the workspace without a charge. If a
  // charges_reset_at is set (a one-off "start from scratch"), only charge leads
  // delivered AFTER that point — pre-reset/backfilled leads are never re-billed.
  const res = await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     SELECT $1, 'lead_charge', -1, l.id,
            'Lead delivered: ' || COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') ||
            CASE WHEN l.company_name IS NOT NULL THEN ' (' || l.company_name || ')' ELSE '' END,
            'system'
       FROM esp_leads l
      WHERE l.workspace_id = $2
        AND l.source IN ('plusvibe', 'bison')
        AND l.label = 'INTERESTED'
        AND ($3::timestamptz IS NULL
             OR COALESCE(l.first_replied_at, l.created_at, l.synced_at) > $3::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM portal_ledger pl
           WHERE pl.client_id = $1 AND pl.lead_id = l.id AND pl.type = 'lead_charge'
        )
     ON CONFLICT (client_id, lead_id) WHERE type = 'lead_charge' DO NOTHING`,
    [clientId, row.workspace_id, row.charges_reset_at ?? null]
  )
  return res.rowCount ?? 0
}

// Credit +1 lead back when a non-lead dispute is approved. Idempotent.
export async function refundLead(clientId: string, leadId: string): Promise<void> {
  // Only refund a lead that was actually charged — never mint credits.
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     SELECT $1, 'dispute_refund', 1, $2, 'Refund: non-lead approved', 'admin'
      WHERE EXISTS (
        SELECT 1 FROM portal_ledger WHERE client_id = $1 AND lead_id = $2 AND type = 'lead_charge'
      )
     ON CONFLICT (client_id, lead_id) WHERE type = 'dispute_refund' DO NOTHING`,
    [clientId, leadId]
  )
}

// amount = number of LEADS to add to the balance.
export async function addTopup(clientId: string, leads: number, note?: string): Promise<void> {
  if (!Number.isFinite(leads) || leads <= 0) throw new Error(`addTopup: invalid lead count ${leads}`)
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'topup', $2, $3, 'admin')`,
    [clientId, Math.floor(leads), note ?? 'Top-up']
  )
}

export async function addAdjustment(clientId: string, amount: number, note: string): Promise<void> {
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'adjustment', $2, $3, 'admin')`,
    [clientId, amount, note]
  )
}
