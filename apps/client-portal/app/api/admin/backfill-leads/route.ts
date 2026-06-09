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

  const PLUSVIBE_API_URL = process.env.PLUSVIBE_API_URL || 'https://api.plusvibe.ai/api/v1'
  const PLUSVIBE_API_KEY = process.env.PLUSVIBE_API_KEY
  if (!PLUSVIBE_API_KEY) return NextResponse.json({ error: 'PLUSVIBE_API_KEY not configured' }, { status: 500 })

  try {
    const results = { workspaces: 0, campaigns: 0, leads: 0, errors: [] as string[] }

    // 1. Fetch all workspaces from PlusVibe
    console.log('[backfill] fetching workspaces from PlusVibe...')
    const wsRes = await fetch(`${PLUSVIBE_API_URL}/workspaces`, {
      headers: { 'x-api-key': PLUSVIBE_API_KEY }
    })
    if (!wsRes.ok) throw new Error(`PlusVibe API error: ${wsRes.statusText}`)
    const workspaces = await wsRes.json() as { id: string; name: string }[]

    for (const ws of workspaces) {
      try {
        results.workspaces++

        // 2. Fetch all INTERESTED leads for this workspace (PlusVibe uses workspace-wide queries, not per-campaign)
        console.log(`[backfill] workspace ${ws.name}: fetching leads...`)
        let page = 1
        let workspaceLeadCount = 0
        const limit = 100

        while (true) {
          const leadRes = await fetch(
            `${PLUSVIBE_API_URL}/lead/workspace-leads?workspace_id=${ws.id}&label=INTERESTED&page=${page}&limit=${limit}`,
            { headers: { 'x-api-key': PLUSVIBE_API_KEY } }
          )
          if (!leadRes.ok) {
            console.warn(`[backfill] workspace ${ws.name} page ${page}: ${leadRes.status}`)
            break
          }
          const response = await leadRes.json() as PVLead[] | { data?: PVLead[]; leads?: PVLead[] }
          const leads = Array.isArray(response) ? response : (response.data ?? response.leads ?? [])
          if (!leads || leads.length === 0) break

          console.log(`[backfill] workspace ${ws.name}: page ${page} has ${leads.length} leads`)

          // 3. Upsert each lead into esp_leads
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
              lead.campaign_id || null,
              'plusvibe',
              lead.email,
              lead.first_name || null,
              lead.last_name || null,
              lead.company_name || null,
              lead.status || null,
              'INTERESTED', // label from the query
              JSON.stringify(lead),
              lead.created_at || new Date().toISOString(),
              new Date().toISOString()
            ])
            workspaceLeadCount++
          }

          if (leads.length < limit) break
          page++
        }

        results.leads += workspaceLeadCount
        console.log(`[backfill] workspace ${ws.name}: ${workspaceLeadCount} total leads`)
      } catch (err) {
        results.errors.push(`Workspace ${ws.name}: ${String(err)}`)
      }
    }

    // Log completion (skip logging — esp_sync_log requires workspace_id which doesn't apply to global backfill)
    // Results are visible in the response and Easypanel logs

    console.log('[backfill] complete:', results)
    return NextResponse.json(results)
  } catch (err) {
    console.error('[backfill-leads] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
