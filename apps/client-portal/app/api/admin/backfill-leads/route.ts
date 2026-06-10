import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getWorkspaces, getLeads, getEmails } from '@/lib/plusvibe'
import { reconcileLeadCharges } from '@/lib/balance'

// Admin-only: backfill from PlusVibe.
//  1. INTERESTED leads -> esp_leads (full lead JSON in raw)
//  2. Real email conversations -> portal_emails (paged via page_trail)
//  3. Reconcile lead-charge ledger rows for any clients in each workspace
// Idempotent: safe to re-run. ?emails=0 skips the (slower) email pull.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.PLUSVIBE_API_KEY && !process.env.PLUSVIBE_KEY) {
    return NextResponse.json({ error: 'PLUSVIBE_API_KEY not configured' }, { status: 500 })
  }
  const withEmails = new URL(req.url).searchParams.get('emails') !== '0'
  const MAX_EMAIL_PAGES = 80 // safety cap (~ pages of replies per workspace)

  try {
    const results = { workspaces: 0, leads: 0, emails: 0, charges: 0, errors: [] as string[] }
    const workspaces = await getWorkspaces()

    for (const ws of workspaces) {
      try {
        results.workspaces++

        // 1. INTERESTED leads -> esp_leads
        let page = 1
        const limit = 100
        while (true) {
          const leads = await getLeads(ws.id, 'INTERESTED', page, limit)
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
                lead._id, ws.id, lead.campaign_id ?? null,
                lead.email, lead.first_name ?? null, lead.last_name ?? null,
                lead.company_name ?? null, lead.status ?? null,
                JSON.stringify(lead), lead.created_at ?? new Date().toISOString(),
              ]
            )
            results.leads++
          }
          if (leads.length < limit) break
          page++
        }

        // 2. Real email conversations -> portal_emails
        if (withEmails) {
          let trail = ''
          let pages = 0
          while (pages < MAX_EMAIL_PAGES) {
            const { pageTrail, data } = await getEmails(ws.id, { pageTrail: trail || undefined })
            if (!data.length) break
            for (const m of data) {
              await pool.query(
                `INSERT INTO portal_emails (
                   id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
                   subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
                   pv_label, is_unread, message_id, timestamp_created, raw
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
                 ON CONFLICT (id) DO UPDATE SET
                   is_unread=$16, pv_label=$15, body_html=$9, body_text=$10, synced_at=NOW()`,
                [
                  m.id, ws.id, m.lead_id ?? null,
                  (m.lead ?? m.from_address_email ?? '').toLowerCase(),
                  m.thread_id ?? null, m.campaign_id ?? null, m.direction ?? 'IN',
                  m.subject ?? null, m.body?.html ?? null, m.body?.text ?? null,
                  m.content_preview ?? null, m.from_address_email ?? null,
                  m.to_address_email_list ?? null, m.eaccount ?? null,
                  m.label ?? null, m.is_unread ?? 0, m.message_id ?? null,
                  m.timestamp_created ?? null, JSON.stringify(m),
                ]
              )
              results.emails++
            }
            if (!pageTrail || pageTrail === trail) break
            trail = pageTrail
            pages++
          }
        }

        // 3. Reconcile lead-charge ledger for any clients in this workspace
        const clients = await pool.query(`SELECT id FROM portal_clients WHERE workspace_id = $1`, [ws.id])
        for (const c of clients.rows) {
          results.charges += await reconcileLeadCharges(c.id)
        }
      } catch (err) {
        results.errors.push(`Workspace ${ws.name}: ${String(err)}`)
      }
    }

    console.log('[backfill] complete:', { ...results, errors: results.errors.length })
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
