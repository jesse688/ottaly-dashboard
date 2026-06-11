import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { getLeads, BISON_CONFIGURED } from '@/lib/bison'
import { ready } from '@/lib/db'

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!BISON_CONFIGURED) return NextResponse.json({ error: 'BISON_API_KEY not configured' }, { status: 500 })

  await ready()

  try {
    const results = { leads: 0, errors: [] as string[] }
    const startTime = Date.now()

    // Fetch all replied leads from Bison (paginated)
    let page = 1
    while (true) {
      const leads = await getLeads(page, 100)
      if (!leads.length) break

      for (const lead of leads) {
        // workspace_id for Bison leads is the Bison workspace ID (from event.workspace_id)
        // Fall back to a default if not set in the lead object
        const workspaceId = process.env.BISON_WORKSPACE_ID ?? 'bison-default'
        await pool.query(
          `INSERT INTO esp_leads (
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
            updated_at = $13`,
          [
            String(lead.id), workspaceId,
            null, // campaign_id not exposed on BisonLead
            'bison',
            lead.email, lead.first_name ?? null, lead.last_name ?? null,
            lead.company ?? null, lead.status ?? null,
            'INTERESTED',
            JSON.stringify(lead),
            lead.created_at ?? new Date().toISOString(),
            new Date().toISOString(),
          ]
        )
        results.leads++
      }

      if (leads.length < 100) break
      page++
    }

    await pool.query(
      `INSERT INTO esp_sync_log (source, status, leads_synced, error, finished_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['bison-polling', results.errors.length === 0 ? 'success' : 'partial', results.leads,
       results.errors.length > 0 ? results.errors.slice(0, 5).join('; ') : null]
    ).catch(() => {})

    const duration = Date.now() - startTime
    console.log(`[cron/sync-bison] complete in ${duration}ms:`, results)
    return NextResponse.json({ ...results, duration })
  } catch (err) {
    console.error('[cron/sync-bison] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
