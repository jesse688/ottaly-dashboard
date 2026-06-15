import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLeadRepliesByEmail, bisonTeamForWorkspace } from '@/lib/bison'

// One-time (re-runnable) cleanup: for leads ALREADY in the portal (esp_leads),
// check each one's Bison conversation and mark it "responded" if a reply was
// actually sent — so historic leads (incl. PlusVibe-imported ones) that were
// already replied to in Bison drop off "Needs reply" for ALL clients.
//
// Unlike /api/admin/backfill-leads (which pulls Bison's tagged-lead list), this
// works off the leads the portal ALREADY shows, so it covers leads that aren't
// tagged in Bison. Pulls one Bison thread per lead → can take a while.
//
// POST ?workspace=<pvId>  → just that client (faster, for testing)
// POST                    → all clients
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const onlyWs = new URL(req.url).searchParams.get('workspace')

  // The portal's visible leads (same filter as the leads list): INTERESTED.
  const leadsRes = await pool.query(
    `SELECT DISTINCT l.workspace_id, lower(l.email) AS email
       FROM esp_leads l
       JOIN portal_clients c ON c.workspace_id = l.workspace_id
      WHERE l.email IS NOT NULL AND l.email <> ''
        AND l.label = 'INTERESTED'
        AND l.source IN ('plusvibe','bison')
        ${onlyWs ? 'AND l.workspace_id = $1' : ''}
        -- skip ones we've already marked responded
        AND NOT EXISTS (
          SELECT 1 FROM portal_lead_data d
          JOIN portal_clients c2 ON c2.id = d.client_id
          WHERE c2.workspace_id = l.workspace_id
            AND d.lead_id = l.id AND d.first_responded_at IS NOT NULL)`,
    onlyWs ? [onlyWs] : []
  )

  const result = { checked: 0, marked: 0, errors: 0 }
  for (const row of leadsRes.rows) {
    const workspaceId = String(row.workspace_id)
    const email = String(row.email)
    result.checked++
    try {
      let responded = false

      // 1) Check the thread ALREADY stored in portal_emails (covers leads whose
      //    conversation was synced earlier, incl. PlusVibe history). A genuine
      //    response = an OUT/portal-sent message after the prospect's first IN.
      const pe = await pool.query(
        `SELECT direction, sent_via_portal, timestamp_created FROM portal_emails
          WHERE workspace_id = $1 AND lower(lead_email) = $2`,
        [workspaceId, email]
      )
      const firstInPe = pe.rows
        .filter(r => r.direction === 'IN')
        .map(r => r.timestamp_created ? new Date(r.timestamp_created).getTime() : 0)
        .filter(Boolean).sort((a, b) => a - b)[0] ?? 0
      responded = pe.rows.some(r =>
        r.sent_via_portal ||
        (r.direction === 'OUT' && r.timestamp_created &&
          (!firstInPe || new Date(r.timestamp_created).getTime() > firstInPe)))

      // 2) Else, if the lead exists in Bison, pull its live thread and check there.
      const teamId = bisonTeamForWorkspace(workspaceId)
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
          [workspaceId, email]
        )
        result.marked++
      }
    } catch {
      result.errors++
    }
  }

  return NextResponse.json(result)
}
