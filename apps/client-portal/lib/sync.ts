import pool from './db'
import { getLeads, getEmails } from './plusvibe'
import { reconcileLeadCharges } from './balance'

const MAX_EMAIL_PAGES = 80

// Enrich one lead with its full PlusVibe record (phone, job title, industry,
// location, LinkedIn, etc.) — webhook-created leads arrive with only basic fields,
// so we look the lead up and overwrite raw + the structured columns with the
// complete data. Best-effort; scans recent INTERESTED leads (cap 5 pages).
export async function enrichLead(workspaceId: string, leadEmail: string): Promise<boolean> {
  if (!leadEmail) return false
  try {
    for (let page = 1; page <= 5; page++) {
      const leads = await getLeads(workspaceId, 'INTERESTED', page, 100)
      if (!leads.length) break
      const lead = leads.find(l => (l.email ?? '').toLowerCase() === leadEmail.toLowerCase())
      if (lead) {
        await pool.query(
          `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, raw, created_at, updated_at)
           VALUES ($1,$2,$3,'plusvibe',$4,$5,$6,$7,$8,'INTERESTED',$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
             email=$4, first_name=$5, last_name=$6, company_name=$7, status=$8, label='INTERESTED', raw=$9, updated_at=NOW()`,
          [lead._id, workspaceId, lead.campaign_id ?? null, lead.email, lead.first_name ?? null, lead.last_name ?? null,
           lead.company_name ?? null, lead.status ?? null, JSON.stringify(lead), lead.created_at ?? new Date().toISOString()]
        )
        return true
      }
      if (leads.length < 100) break
    }
  } catch (err) { console.error('[enrichLead] failed:', err) }
  return false
}

// Backfill a single workspace from PlusVibe: INTERESTED leads + real email
// conversations, then reconcile lead-charges for any clients in it. Idempotent.
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
    const leads = await getLeads(workspaceId, 'INTERESTED', page, limit)
    if (!leads.length) break
    for (const lead of leads) {
      await pool.query(
        `INSERT INTO esp_leads (
           id, workspace_id, campaign_id, source,
           email, first_name, last_name, company_name, status, label, raw, created_at, updated_at
         ) VALUES ($1,$2,$3,'plusvibe',$4,$5,$6,$7,$8,'INTERESTED',$9,$10,NOW())
         ON CONFLICT (id) DO UPDATE SET
           email=$4, first_name=$5, last_name=$6, company_name=$7,
           status=$8, label='INTERESTED', raw=$9, updated_at=NOW()`,
        [
          lead._id, workspaceId, lead.campaign_id ?? null,
          lead.email, lead.first_name ?? null, lead.last_name ?? null,
          lead.company_name ?? null, lead.status ?? null,
          JSON.stringify(lead), lead.created_at ?? new Date().toISOString(),
        ]
      )
      leadCount++
    }
    if (leads.length < limit) break
    page++
  }

  // 2. Real email conversations -> portal_emails
  if (withEmails) {
    let trail = ''
    let pages = 0
    while (pages < MAX_EMAIL_PAGES) {
      const { pageTrail, data } = await getEmails(workspaceId, { pageTrail: trail || undefined })
      if (!data.length) break
      for (const m of data) {
        await pool.query(
          `INSERT INTO portal_emails (
             id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
             subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
             pv_label, is_unread, message_id, timestamp_created, raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id) DO UPDATE SET is_unread=$16, pv_label=$15, body_html=$9, body_text=$10, synced_at=NOW()`,
          [
            m.id, workspaceId, m.lead_id ?? null,
            (m.lead ?? m.from_address_email ?? '').toLowerCase(),
            m.thread_id ?? null, m.campaign_id ?? null, m.direction ?? 'IN',
            m.subject ?? null, m.body?.html ?? null, m.body?.text ?? null,
            m.content_preview ?? null, m.from_address_email ?? null,
            m.to_address_email_list ?? null, m.eaccount ?? null,
            m.label ?? null, m.is_unread ?? 0, m.message_id ?? null,
            m.timestamp_created ?? null, JSON.stringify(m),
          ]
        )
        emailCount++
      }
      if (!pageTrail || pageTrail === trail) break
      trail = pageTrail
      pages++
    }
  }

  // 3. Reconcile lead-charge ledger for any clients in this workspace
  const clients = await pool.query(`SELECT id FROM portal_clients WHERE workspace_id = $1`, [workspaceId])
  for (const c of clients.rows) charges += await reconcileLeadCharges(c.id)

  return { leads: leadCount, emails: emailCount, charges }
}
