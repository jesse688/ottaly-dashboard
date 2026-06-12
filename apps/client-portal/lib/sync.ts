import pool from './db'
import { getLeads, getLeadReplies, bisonTeamForWorkspace } from './bison'
import { reconcileLeadCharges } from './balance'

// Enrich a newly-arrived lead with its full Bison record. Best-effort.
export async function enrichLead(workspaceId: string, leadEmail: string): Promise<boolean> {
  if (!leadEmail) return false
  try {
    for (let page = 1; page <= 5; page++) {
      const leads = await getLeads(page, 100, bisonTeamForWorkspace(workspaceId))
      if (!leads.length) break
      const lead = leads.find(l => (l.email ?? '').toLowerCase() === leadEmail.toLowerCase())
      if (lead) {
        await pool.query(
          `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, raw, created_at, updated_at)
           VALUES ($1,$2,$3,'bison',$4,$5,$6,$7,$8,'INTERESTED',$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
             email=$4, first_name=$5, last_name=$6, company_name=$7, status=$8, label='INTERESTED', raw=$9, updated_at=NOW()`,
          [String(lead.id), workspaceId, null,
           lead.email, lead.first_name ?? null, lead.last_name ?? null,
           lead.company ?? null, lead.status ?? null,
           JSON.stringify(lead), lead.created_at ?? new Date().toISOString()]
        )
        return true
      }
      if (leads.length < 100) break
    }
  } catch (err) { console.error('[enrichLead] failed:', err) }
  return false
}

// Backfill a workspace from Bison: INTERESTED leads + email conversations + charges.
export async function backfillWorkspace(
  workspaceId: string,
  opts: { withEmails?: boolean } = {}
): Promise<{ leads: number; emails: number; charges: number }> {
  const withEmails = opts.withEmails !== false
  let leadCount = 0
  let emailCount = 0

  let page = 1
  while (true) {
    const leads = await getLeads(page, 100, bisonTeamForWorkspace(workspaceId))
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
          String(lead.id), workspaceId,
          null, // campaign_id not exposed on BisonLead
          lead.email, lead.first_name ?? null, lead.last_name ?? null,
          lead.company ?? null, lead.status ?? null,
          JSON.stringify(lead), lead.created_at ?? new Date().toISOString(),
        ]
      )
      leadCount++

      if (withEmails) {
        try {
          const replies = await getLeadReplies(String(lead.id))
          for (const m of replies) {
            const direction = m.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
            await pool.query(
              `INSERT INTO portal_emails (
                 id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
                 subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
                 pv_label, is_unread, message_id, timestamp_created, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
               ON CONFLICT (id) DO NOTHING`,
              [
                String(m.id), workspaceId,
                m.lead_id ? String(m.lead_id) : null,
                lead.email.toLowerCase(),
                m.parent_id ? String(m.parent_id) : null,
                m.campaign_id ? String(m.campaign_id) : null,
                direction,
                m.subject ?? null, m.html_body ?? null, m.text_body ?? null,
                m.text_body?.slice(0, 200) ?? null,
                m.from_email_address ?? null, m.primary_to_email_address ?? null,
                null, m.interested ? 'INTERESTED' : null,
                m.read ? 0 : 1, m.raw_message_id ?? null,
                m.date_received ?? null, JSON.stringify(m),
              ]
            )
            emailCount++
          }
        } catch { /* best-effort */ }
      }
    }
    if (leads.length < 100) break
    page++
  }

  const clients = await pool.query(`SELECT id FROM portal_clients WHERE workspace_id = $1`, [workspaceId])
  let charges = 0
  for (const c of clients.rows) charges += await reconcileLeadCharges(c.id)

  return { leads: leadCount, emails: emailCount, charges }
}
