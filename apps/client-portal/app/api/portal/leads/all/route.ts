import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const configRes = await pool.query(
      'SELECT hidden_labels FROM portal_clients WHERE id = $1',
      [session.clientId]
    )
    const hiddenLabels: string[] = configRes.rows[0]?.hidden_labels ?? []

    // Try full query with new tables first; fall back to base query if migration not yet run
    let rows: Record<string, unknown>[]
    try {
      const res = await pool.query(
        `SELECT l.id, l.email, l.first_name, l.last_name, l.company_name,
                l.status, l.label, l.first_replied_at,
                l.raw->>'job_title'           AS job_title,
                l.raw->>'industry'            AS industry,
                l.raw->>'city'                AS city,
                l.raw->>'country'             AS country,
                l.raw->>'linkedin_person_url' AS linkedin_url,
                l.raw->>'phone_number'        AS phone_number,
                c.name AS campaign_name,
                ld.deal_value,
                ld.notes AS deal_notes,
                pd.status AS dispute_status,
                pd.reason AS dispute_reason,
                pd.admin_note AS dispute_admin_note
         FROM esp_leads l
         LEFT JOIN esp_campaigns c ON c.id = l.campaign_id AND c.source = 'plusvibe'
         LEFT JOIN portal_lead_data ld ON ld.lead_id = l.id AND ld.client_id = $3
         LEFT JOIN portal_lead_disputes pd ON pd.lead_id = l.id AND pd.client_id = $3
         WHERE l.workspace_id = $1
           AND l.source = 'plusvibe'
           AND l.label IS NOT NULL
           AND ($2::text[] = '{}' OR l.label != ALL($2::text[]))
         ORDER BY l.first_replied_at DESC NULLS LAST, l.created_at DESC`,
        [session.workspaceId, hiddenLabels, session.clientId]
      )
      rows = res.rows
    } catch {
      // New tables not yet created — run the base query without them
      const res = await pool.query(
        `SELECT l.id, l.email, l.first_name, l.last_name, l.company_name,
                l.status, l.label, l.first_replied_at,
                l.raw->>'job_title'           AS job_title,
                l.raw->>'industry'            AS industry,
                l.raw->>'city'                AS city,
                l.raw->>'country'             AS country,
                l.raw->>'linkedin_person_url' AS linkedin_url,
                l.raw->>'phone_number'        AS phone_number,
                c.name AS campaign_name,
                NULL::numeric AS deal_value,
                NULL::text    AS deal_notes,
                NULL::text    AS dispute_status,
                NULL::text    AS dispute_reason,
                NULL::text    AS dispute_admin_note
         FROM esp_leads l
         LEFT JOIN esp_campaigns c ON c.id = l.campaign_id AND c.source = 'plusvibe'
         WHERE l.workspace_id = $1
           AND l.source = 'plusvibe'
           AND l.label IS NOT NULL
           AND ($2::text[] = '{}' OR l.label != ALL($2::text[]))
         ORDER BY l.first_replied_at DESC NULLS LAST, l.created_at DESC`,
        [session.workspaceId, hiddenLabels]
      )
      rows = res.rows
    }

    return NextResponse.json(rows)
  } catch (err) {
    console.error('[portal/leads/all]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
