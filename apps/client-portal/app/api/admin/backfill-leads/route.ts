import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface PVLead {
  id: string
  email: string
  first_name?: string
  last_name?: string
  company_name?: string
  status?: string
  variables?: Record<string, unknown>
  created_at?: string
  [key: string]: unknown
}

// Admin-only endpoint: backfill leads from PlusVibe API
// Fetches all workspaces → campaigns → leads from PlusVibe, inserts into esp_leads
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const PLUSVIBE_API_URL = process.env.PLUSVIBE_API_URL || 'https://api.plusvibe.com/v1'
  const PLUSVIBE_API_KEY = process.env.PLUSVIBE_API_KEY
  if (!PLUSVIBE_API_KEY) return NextResponse.json({ error: 'PLUSVIBE_API_KEY not configured' }, { status: 500 })

  try {
    const results = { workspaces: 0, campaigns: 0, leads: 0, errors: [] as string[] }

    // 1. Fetch all workspaces from PlusVibe
    console.log('[backfill] fetching workspaces from PlusVibe...')
    const wsRes = await fetch(`${PLUSVIBE_API_URL}/workspaces`, {
      headers: { 'Authorization': `Bearer ${PLUSVIBE_API_KEY}` }
    })
    if (!wsRes.ok) throw new Error(`PlusVibe API error: ${wsRes.statusText}`)
    const workspaces = await wsRes.json() as { id: string; name: string }[]

    for (const ws of workspaces) {
      try {
        // 2. Fetch campaigns for this workspace
        console.log(`[backfill] workspace ${ws.name}: fetching campaigns...`)
        const campRes = await fetch(`${PLUSVIBE_API_URL}/workspaces/${ws.id}/campaigns`, {
          headers: { 'Authorization': `Bearer ${PLUSVIBE_API_KEY}` }
        })
        if (!campRes.ok) {
          results.errors.push(`Workspace ${ws.name}: failed to fetch campaigns`)
          continue
        }
        const campaigns = await campRes.json() as { id: string; name: string }[]
        results.workspaces++

        for (const camp of campaigns) {
          try {
            // 3. Fetch leads for this campaign (paginated)
            let skip = 0
            let campaignLeadCount = 0
            const limit = 100

            while (true) {
              console.log(`[backfill] workspace ${ws.name}, campaign ${camp.name}: fetching leads (skip=${skip})...`)
              const leadRes = await fetch(
                `${PLUSVIBE_API_URL}/workspaces/${ws.id}/campaigns/${camp.id}/leads?skip=${skip}&limit=${limit}`,
                { headers: { 'Authorization': `Bearer ${PLUSVIBE_API_KEY}` } }
              )
              if (!leadRes.ok) break
              const leads = await leadRes.json() as PVLead[]
              if (!leads || leads.length === 0) break

              // 4. Upsert each lead into esp_leads
              for (const lead of leads) {
                await pool.query(`
                  INSERT INTO esp_leads (
                    id, workspace_id, campaign_id, source,
                    email, first_name, last_name, company_name, status,
                    label, raw, created_at, updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                  ON CONFLICT (id) DO UPDATE SET
                    email = $5, first_name = $6, last_name = $7, company_name = $8,
                    status = $9, raw = $11, updated_at = $13
                  WHERE esp_leads.first_replied_at IS NULL OR $13 > esp_leads.updated_at
                `, [
                  lead.id,
                  ws.id,
                  camp.id,
                  'plusvibe',
                  lead.email,
                  lead.first_name || null,
                  lead.last_name || null,
                  lead.company_name || null,
                  lead.status || null,
                  null, // label: no label from PlusVibe yet
                  JSON.stringify(lead),
                  lead.created_at || new Date().toISOString(),
                  new Date().toISOString()
                ])
                campaignLeadCount++
              }

              skip += limit
              if (leads.length < limit) break // Last page
            }

            results.leads += campaignLeadCount
            results.campaigns++
            console.log(`[backfill] campaign ${camp.name}: ${campaignLeadCount} leads`)
          } catch (err) {
            results.errors.push(`Campaign ${camp.name}: ${String(err)}`)
          }
        }
      } catch (err) {
        results.errors.push(`Workspace ${ws.name}: ${String(err)}`)
      }
    }

    // Log completion
    await pool.query(`
      INSERT INTO esp_sync_log (source, status, leads_synced, error, finished_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, ['plusvibe', results.errors.length === 0 ? 'success' : 'partial', results.leads, results.errors.length > 0 ? results.errors.join('; ') : null])

    console.log('[backfill] complete:', results)
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
