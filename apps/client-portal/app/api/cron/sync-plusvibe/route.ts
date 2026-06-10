import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { registerWebhook } from '@/lib/plusvibe'

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

// GET /api/cron/sync-plusvibe?secret=<SECRET>
// Polling job to reconcile PlusVibe leads (runs every 30 minutes)
// Catches any webhook misses and ensures data stays fresh
export async function GET(req: NextRequest) {
  // Verify secret to prevent unauthorized access
  const secret = new URL(req.url).searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const PLUSVIBE_API_URL = process.env.PLUSVIBE_API_URL || 'https://api.plusvibe.ai/api/v1'
  const PLUSVIBE_API_KEY = process.env.PLUSVIBE_API_KEY
  if (!PLUSVIBE_API_KEY) return NextResponse.json({ error: 'PLUSVIBE_API_KEY not configured' }, { status: 500 })

  try {
    const results = { workspaces: 0, leads: 0, webhooks: 0, errors: [] as string[] }
    const startTime = Date.now()

    // Fetch all workspaces from PlusVibe
    const wsRes = await fetch(`${PLUSVIBE_API_URL}/workspaces`, {
      headers: { 'x-api-key': PLUSVIBE_API_KEY }
    })
    if (!wsRes.ok) throw new Error(`PlusVibe API error: ${wsRes.statusText}`)
    const workspaces = await wsRes.json() as { id: string; name: string }[]

    for (const ws of workspaces) {
      try {
        results.workspaces++

        // Fetch all INTERESTED leads for this workspace (paginated)
        let page = 1
        let workspaceLeadCount = 0
        const limit = 100

        while (true) {
          const leadRes = await fetch(
            `${PLUSVIBE_API_URL}/lead/workspace-leads?workspace_id=${ws.id}&label=INTERESTED&page=${page}&limit=${limit}`,
            { headers: { 'x-api-key': PLUSVIBE_API_KEY } }
          )
          if (!leadRes.ok) break
          const response = await leadRes.json() as PVLead[] | { data?: PVLead[]; leads?: PVLead[] }
          const leads = Array.isArray(response) ? response : (response.data ?? response.leads ?? [])
          if (!leads || leads.length === 0) break

          // Upsert each lead into esp_leads
          for (const lead of leads) {
            await pool.query(`
              INSERT INTO esp_leads (
                id, workspace_id, campaign_id, source,
                email, first_name, last_name, company_name, status,
                label, raw, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (id) DO UPDATE SET
                email = COALESCE($5, esp_leads.email),
                first_name = COALESCE($6, esp_leads.first_name),
                last_name = COALESCE($7, esp_leads.last_name),
                company_name = COALESCE($8, esp_leads.company_name),
                status = COALESCE($9, esp_leads.status),
                raw = $11,
                updated_at = $13
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
      } catch (err) {
        results.errors.push(`Workspace ${ws.name}: ${String(err)}`)
      }
    }

    // Ensure / upgrade webhooks for every workspace that has a portal client.
    // Reply-only hooks (created on empty workspaces) auto-upgrade to include the
    // lead event once the "Lead" label has been used at least once.
    try {
      const clientWs = await pool.query(`SELECT DISTINCT workspace_id FROM portal_clients`)
      for (const row of clientWs.rows) {
        const r = await registerWebhook(row.workspace_id)
        if (r.ok && r.reason === 'created') results.webhooks++
      }
    } catch (err) {
      results.errors.push(`webhook upgrade: ${String(err)}`)
    }

    // Log to audit trail
    const duration = Date.now() - startTime
    await pool.query(`
      INSERT INTO esp_sync_log (source, status, leads_synced, error, finished_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [
      'plusvibe-polling',
      results.errors.length === 0 ? 'success' : 'partial',
      results.leads,
      results.errors.length > 0 ? results.errors.slice(0, 5).join('; ') : null
    ])

    console.log(`[cron/sync-plusvibe] complete in ${duration}ms:`, results)
    return NextResponse.json({ ...results, duration })
  } catch (err) {
    console.error('[cron/sync-plusvibe] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
