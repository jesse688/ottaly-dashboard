import pool from './db'

// Pay-per-lead clients are billed per delivered lead (card auto-charge) instead of
// pre-paying a balance, so their leads NEVER lock and they never top up. Matched by
// workspace id OR company name 'bubble' (mirrors the Billing page). Hardcoded for now.
const PAY_PER_LEAD_WORKSPACES = new Set(['6a0e29d0d004be93be3f33f2']) // Bubble
const PAY_PER_LEAD_COMPANIES = new Set(['bubble'])

// Billing redirect: a client may point at ANOTHER client to pool one balance.
// SOP keeps its own workspace + leads, but its charges/balance resolve to the
// target (ButterflyEco SOP → ButterflyEco). Returns the client's own id when
// there is no redirect. Single hop only — chains are not followed.
export async function billingClientId(clientId: string): Promise<string> {
  const r = await pool.query(
    `SELECT billing_client_id FROM portal_clients WHERE id = $1`,
    [clientId]
  )
  return (r.rows[0]?.billing_client_id as string | null) ?? clientId
}

export async function isPayPerLead(clientId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT workspace_id, company_name FROM portal_clients WHERE id = $1`,
    [clientId]
  )
  const row = r.rows[0]
  if (!row) return false
  const ws = String(row.workspace_id ?? '').trim().toLowerCase()
  const co = String(row.company_name ?? '').trim().toLowerCase()
  return PAY_PER_LEAD_WORKSPACES.has(ws) || PAY_PER_LEAD_COMPANIES.has(co)
}

// The lead balance is a COUNT OF LEADS (not money). Signed sum of ledger rows:
//   topup (+N leads) · dispute_refund (+1) · adjustment (+/-) · lead_charge (-1)
// cost_per_lead (£) is only used to value top-ups / show £ alongside — never the unit.
export async function getBalance(clientId: string): Promise<number> {
  const target = await billingClientId(clientId)
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM portal_ledger WHERE client_id = $1`,
    [target]
  )
  return Number(r.rows[0]?.balance ?? 0)
}

// Leads delivered while the client is out of credit are "locked" — shown as a
// teaser (name only) with contact details + conversation hidden until a top-up
// is paid. Locking is DERIVED from the ledger, not stored: the newest
// (delivered − creditsGranted) charged leads are locked, so a paid top-up
// automatically unlocks the oldest locked leads, up to the amount paid.
export async function getLockedLeadIds(clientId: string): Promise<Set<string>> {
  // Pay-per-lead clients never run out of credit → nothing ever locks.
  if (await isPayPerLead(clientId)) return new Set<string>()
  // Locking is computed on the SHARED pool. For a redirected client (SOP), this
  // sums credits + ALL charges across the billing group, so locks reflect the
  // pooled balance — not SOP's own (now empty) ledger.
  const target = await billingClientId(clientId)
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type <> 'lead_charge'), 0) AS credits,
            COUNT(*) FILTER (WHERE type = 'lead_charge')                  AS delivered
       FROM portal_ledger WHERE client_id = $1`,
    [target]
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
    [target, lockedCount]
  )
  return new Set<string>(locked.rows.map(x => x.lead_id as string))
}

export async function getLedger(clientId: string, limit = 100) {
  const target = await billingClientId(clientId)
  const r = await pool.query(
    `SELECT id, type, amount, lead_id, description, created_by, created_at
       FROM portal_ledger WHERE client_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [target, limit]
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

  // Charges are written against the BILLING target, not necessarily this client.
  // A redirected client (SOP) scans ITS OWN workspace for delivered leads, but
  // the -1 lead_charge rows land on the target's ledger (ButterflyEco) so both
  // workspaces draw down one shared balance. Dedup key (client_id, lead_id) is
  // safe: the grouped clients have disjoint workspaces → disjoint lead ids.
  const chargeClientId = await billingClientId(clientId)

  // -1 lead for every INTERESTED lead in the workspace without a charge. If a
  // charges_reset_at is set (a one-off "start from scratch"), only charge leads
  // delivered AFTER that point — pre-reset/backfilled leads are never re-billed.
  // -1 ONCE PER EMAIL, not once per esp_leads row. Duplicate ingest paths can
  // create TWO esp_leads rows for the same person (different synthetic ids) — the
  // (client_id, lead_id) unique index wouldn't stop that becoming two charges. So
  // we collapse to one lead per email: DISTINCT ON picks a single lead per email
  // per run, and the email-level NOT EXISTS blocks re-charging across runs when a
  // sibling row for the same email was already billed. NULL emails stay distinct
  // (keyed by id) so they can't wrongly collapse together.
  const res = await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     SELECT DISTINCT ON (COALESCE(lower(l.email), l.id::text))
            $1, 'lead_charge', -1, l.id,
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
        AND NOT EXISTS (
          -- already charged a SIBLING lead with the same email? then skip.
          SELECT 1 FROM portal_ledger pl2
            JOIN esp_leads l2 ON l2.id = pl2.lead_id
           WHERE pl2.client_id = $1 AND pl2.type = 'lead_charge'
             AND l.email IS NOT NULL AND lower(l2.email) = lower(l.email)
        )
      ORDER BY COALESCE(lower(l.email), l.id::text),
               COALESCE(l.first_replied_at, l.created_at, l.synced_at) ASC NULLS LAST
     ON CONFLICT (client_id, lead_id) WHERE type = 'lead_charge' DO NOTHING`,
    [chargeClientId, row.workspace_id, row.charges_reset_at ?? null]
  )
  return res.rowCount ?? 0
}

// Credit +1 lead back when a non-lead dispute is approved. Idempotent.
// Resolves the billing redirect: the charge lives under billingClientId (see
// reconcileLeadCharges:113), so the refund (and its EXISTS guard) MUST key on the
// same target — else a redirected client wins the dispute but the credit lands on
// an unread ledger and is silently lost.
export async function refundLead(clientId: string, leadId: string): Promise<void> {
  const target = await billingClientId(clientId)
  // Only refund a lead that was actually charged — never mint credits.
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, lead_id, description, created_by)
     SELECT $1, 'dispute_refund', 1, $2, 'Refund: non-lead approved', 'admin'
      WHERE EXISTS (
        SELECT 1 FROM portal_ledger WHERE client_id = $1 AND lead_id = $2 AND type = 'lead_charge'
      )
     ON CONFLICT (client_id, lead_id) WHERE type = 'dispute_refund' DO NOTHING`,
    [target, leadId]
  )
}

// amount = number of LEADS to add to the balance.
// Resolves the billing redirect so the credit lands on the SAME ledger every
// read/charge path uses (getBalance/reconcile resolve billingClientId). Without
// this, a top-up for a redirected client never moves their balance.
export async function addTopup(clientId: string, leads: number, note?: string): Promise<void> {
  if (!Number.isFinite(leads) || leads <= 0) throw new Error(`addTopup: invalid lead count ${leads}`)
  const target = await billingClientId(clientId)
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'topup', $2, $3, 'admin')`,
    [target, Math.floor(leads), note ?? 'Top-up']
  )
}

export async function addAdjustment(clientId: string, amount: number, note: string): Promise<void> {
  const target = await billingClientId(clientId)
  await pool.query(
    `INSERT INTO portal_ledger (client_id, type, amount, description, created_by)
     VALUES ($1, 'adjustment', $2, $3, 'admin')`,
    [target, amount, note]
  )
}
