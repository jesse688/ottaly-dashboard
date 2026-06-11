import pool from './db'
import { getLeads, getLeadReplies } from './bison'
import { reconcileLeadCharges } from './balance'

// Backfill interested leads + email threads from EmailBison into local DB.
// Bison has no workspace_id param — API key scopes to one workspace.
// workspaceId is stored as a string label for our DB (maps to portal_clients.workspace_id).
export async function backfillWorkspace(
  workspaceId: string,
  opts: { withEmails?: boolean } = {}
): Promise<{ leads: number; emails: number; charges: number }> {
  const withEmails = opts.withEmails !== false
  let leadCount = 0
  let emailCount = 0
  let charges = 0

  // 1. INTERESTED leads -> esp_leads
  let page = 1
  const limit = 100
  while (true) {
    const leads = await getLeads(page, limit)
    if (!leads.length) break

    for (const lead of leads) {
      await pool.query(
        `INSERT INTO esp_leads (
           id, workspace_id, campaign_id, source,
           email, first_name, last_name, company_name, status, label, raw, created_at, updated_at
         ) VALUES ($1,$2,$3,'bison',$4,$5,$6,$7,$8,'INTERESTED',$9,$10,NOW())
         ON CONFLICT (id) DO UPDATE SET
           email=$4, first_name=$5, last_name=$6, company_name=$7,
           status=$8, label='INTERESTED', raw=$9, updated_at=NOW()`,
        [
          String(lead.id),
          workspaceId,
          null, // Bison doesn't return campaign_id on list endpoint
          lead.email,
          lead.first_name ?? null,
          lead.last_name ?? null,
          lead.company ?? null,
          lead.status ?? null,
          JSON.stringify(lead),
          lead.created_at ?? new Date().toISOString(),
        ]
      )
      leadCount++
    }
    if (leads.length < limit) break
    page++
  }

  // 2. Email conversations -> portal_emails
  if (withEmails) {
    // Fetch reply threads for all INTERESTED leads in this workspace
    const leadsRes = await pool.query(
      `SELECT id, email FROM esp_leads WHERE workspace_id = $1 AND source = 'bison' LIMIT 500`,
      [workspaceId]
    )
    for (const row of leadsRes.rows) {
      try {
        const replies = await getLeadReplies(row.id)
        for (const m of replies) {
          const direction = m.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
          await pool.query(
            `INSERT INTO portal_emails (
               id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
               subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
               pv_label, is_unread, message_id, timestamp_created, raw
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (id) DO UPDATE SET
               is_unread=$16, body_html=$9, body_text=$10, synced_at=NOW()`,
            [
              String(m.id),
              workspaceId,
              m.lead_id ? String(m.lead_id) : row.id,
              row.email,
              m.parent_id ? String(m.parent_id) : null,
              m.campaign_id ? String(m.campaign_id) : null,
              direction,
              m.subject ?? null,
              m.html_body ?? null,
              m.text_body ?? null,
              m.text_body?.slice(0, 200) ?? null,
              m.from_email_address ?? null,
              m.primary_to_email_address ?? null,
              null, // eaccount — not exposed in Bison reply object
              m.interested ? 'INTERESTED' : null,
              m.read ? 0 : 1,
              m.raw_message_id ?? null,
              m.date_received ?? null,
              JSON.stringify(m),
            ]
          )
          emailCount++
        }
      } catch {
        // skip this lead's emails if fetch fails
      }
    }
  }

  // 3. Reconcile lead-charge ledger for any clients in this workspace
  const clients = await pool.query(`SELECT id FROM portal_clients WHERE workspace_id = $1`, [workspaceId])
  for (const c of clients.rows) charges += await reconcileLeadCharges(c.id)

  return { leads: leadCount, emails: emailCount, charges }
}

// Enrich a single lead from Bison (called from webhook on INTERESTED event).
export async function enrichLead(workspaceId: string, leadId: string): Promise<void> {
  try {
    const { getLead } = await import('./bison')
    const lead = await getLead(leadId)
    if (!lead) return
    await pool.query(
      `UPDATE esp_leads SET
         first_name = COALESCE(first_name, $1),
         last_name  = COALESCE(last_name,  $2),
         company_name = COALESCE(company_name, $3),
         raw = $4, updated_at = NOW()
       WHERE id = $5 AND workspace_id = $6`,
      [
        lead.first_name ?? null,
        lead.last_name ?? null,
        lead.company ?? null,
        JSON.stringify(lead),
        leadId,
        workspaceId,
      ]
    )
  } catch {
    // best-effort, don't block webhook
  }
}
