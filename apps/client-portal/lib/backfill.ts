import pool from './db'
import { getLeadRepliesByEmail, bisonTeamForWorkspace } from './bison'

// Mark portal leads "responded" when a reply was actually sent — so leads
// answered in Bison (not via the portal) drop off "Needs reply". Used by both
// the admin one-shot endpoint and the scheduled cron.
//
// A lead leaves "Needs reply" when first_responded_at is stamped. We detect a
// genuine response two ways: (1) the portal_emails thread already has an
// OUT/portal-sent message after the prospect's first inbound; (2) the live Bison
// thread has a 'sent' message after the first inbound. Bison calls are slow
// (one thread per lead) so the cron passes a `limit` to bound each run.
export interface BackfillResult { checked: number; marked: number; errors: number; remaining: number }

export async function backfillReplied(opts: { workspaceId?: string; limit?: number } = {}): Promise<BackfillResult> {
  const { workspaceId, limit } = opts

  // Candidate leads = portal-visible INTERESTED leads not yet marked responded.
  const params: (string | number)[] = []
  let where = `l.email IS NOT NULL AND l.email <> ''
        AND l.label = 'INTERESTED'
        AND l.source IN ('plusvibe','bison')
        AND NOT EXISTS (
          SELECT 1 FROM portal_lead_data d
          JOIN portal_clients c2 ON c2.id = d.client_id
          WHERE c2.workspace_id = l.workspace_id
            AND d.lead_id = l.id AND d.first_responded_at IS NOT NULL)`
  if (workspaceId) { params.push(workspaceId); where += ` AND l.workspace_id = $${params.length}` }

  // Count remaining so the cron can report progress / when it's caught up.
  const countRes = await pool.query(
    `SELECT COUNT(DISTINCT (l.workspace_id, lower(l.email))) AS n
       FROM esp_leads l JOIN portal_clients c ON c.workspace_id = l.workspace_id
      WHERE ${where}`,
    params
  )
  const remainingBefore = Number(countRes.rows[0]?.n ?? 0)

  let limitClause = ''
  if (limit && limit > 0) { params.push(limit); limitClause = ` LIMIT $${params.length}` }
  const leadsRes = await pool.query(
    `SELECT DISTINCT l.workspace_id, lower(l.email) AS email
       FROM esp_leads l
       JOIN portal_clients c ON c.workspace_id = l.workspace_id
      WHERE ${where}${limitClause}`,
    params
  )

  const result = { checked: 0, marked: 0, errors: 0 }
  for (const row of leadsRes.rows) {
    const wsId = String(row.workspace_id)
    const email = String(row.email)
    result.checked++
    try {
      let responded = false

      // 1) Thread already stored in portal_emails.
      const pe = await pool.query(
        `SELECT direction, sent_via_portal, timestamp_created FROM portal_emails
          WHERE workspace_id = $1 AND lower(lead_email) = $2`,
        [wsId, email]
      )
      const firstInPe = pe.rows
        .filter(r => r.direction === 'IN')
        .map(r => r.timestamp_created ? new Date(r.timestamp_created).getTime() : 0)
        .filter(Boolean).sort((a, b) => a - b)[0] ?? 0
      responded = pe.rows.some(r =>
        r.sent_via_portal ||
        (r.direction === 'OUT' && r.timestamp_created &&
          (!firstInPe || new Date(r.timestamp_created).getTime() > firstInPe)))

      // 2) Else check the live Bison thread.
      const teamId = bisonTeamForWorkspace(wsId)
      if (!responded && teamId) {
        const replies = await getLeadRepliesByEmail(email, teamId)
        const inboundTimes = replies
          .filter(m => m.folder?.toLowerCase() !== 'sent')
          .map(m => m.date_received ? new Date(m.date_received).getTime() : 0)
          .filter(Boolean)
        const firstIn = inboundTimes.length ? Math.min(...inboundTimes) : 0
        responded = replies.some(m =>
          m.folder?.toLowerCase() === 'sent' &&
          (!firstIn || (m.date_received ? new Date(m.date_received).getTime() > firstIn : false))
        )
      }

      if (responded) {
        await pool.query(
          `INSERT INTO portal_lead_data (lead_id, client_id, first_responded_at)
           SELECT e.id, c.id, NOW()
             FROM esp_leads e JOIN portal_clients c ON c.workspace_id = e.workspace_id
            WHERE e.workspace_id = $1 AND lower(e.email) = $2
           ON CONFLICT (lead_id, client_id) DO UPDATE
             SET first_responded_at = COALESCE(portal_lead_data.first_responded_at, NOW())`,
          [wsId, email]
        )
        result.marked++
      }
    } catch {
      result.errors++
    }
  }

  return { ...result, remaining: Math.max(0, remainingBefore - result.marked) }
}
