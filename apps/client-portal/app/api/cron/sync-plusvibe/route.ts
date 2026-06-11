// GET /api/cron/sync-plusvibe?secret=<SECRET>
// Polling job to reconcile Bison leads (runs every 30 minutes).
// Catches webhook misses and keeps esp_leads fresh.
import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { ready } from '@/lib/db'
import { getLeads } from '@/lib/bison'

export async function GET(req: NextRequest) {
  await ready()

  const secret = new URL(req.url).searchParams.get('secret')
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.BISON_API_KEY) {
    return NextResponse.json({ error: 'BISON_API_KEY not configured' }, { status: 500 })
  }

  try {
    const results = { leads: 0, errors: [] as string[] }
    const startTime = Date.now()

    // Fetch workspaces from DB (Bison key may cover multiple portal clients via workspace_id label)
    const wsRes = await pool.query(`SELECT DISTINCT workspace_id FROM portal_clients WHERE workspace_id IS NOT NULL`)
    const workspaceIds: string[] = wsRes.rows.map((r: { workspace_id: string }) => r.workspace_id)

    // Bison has a single key → single workspace; we loop in case of future multi-key setup
    // For now just one API key, so we use the first workspace_id from portal_clients
    const workspaceId = workspaceIds[0] ?? 'default'

    let page = 1
    const limit = 100

    while (true) {
      const leads = await getLeads(page, limit)
      if (!leads.length) break

      for (const lead of leads) {
        try {
          await pool.query(
            `INSERT INTO esp_leads (
               id, workspace_id, source,
               email, first_name, last_name, company_name, status,
               label, raw, created_at, updated_at
             ) VALUES ($1,$2,'bison',$3,$4,$5,$6,$7,'INTERESTED',$8,$9,NOW())
             ON CONFLICT (id) DO UPDATE SET
               email = COALESCE($3, esp_leads.email),
               first_name = COALESCE($4, esp_leads.first_name),
               last_name = COALESCE($5, esp_leads.last_name),
               company_name = COALESCE($6, esp_leads.company_name),
               status = COALESCE($7, esp_leads.status),
               source = 'bison',
               raw = $8,
               updated_at = NOW()`,
            [
              String(lead.id),
              workspaceId,
              lead.email,
              lead.first_name ?? null,
              lead.last_name ?? null,
              lead.company ?? null,
              lead.status ?? null,
              JSON.stringify(lead),
              lead.created_at ?? new Date().toISOString(),
            ]
          )
          results.leads++
        } catch (err) {
          results.errors.push(`lead ${lead.id}: ${String(err)}`)
        }
      }

      if (leads.length < limit) break
      page++
    }

    const duration = Date.now() - startTime
    await pool.query(
      `INSERT INTO esp_sync_log (source, status, leads_synced, error, finished_at)
       VALUES ('bison-polling', $1, $2, $3, NOW())`,
      [
        results.errors.length === 0 ? 'success' : 'partial',
        results.leads,
        results.errors.length ? results.errors.slice(0, 5).join('; ') : null,
      ]
    )

    console.log(`[cron/sync-bison] complete in ${duration}ms:`, results)
    return NextResponse.json({ ...results, duration })
  } catch (err) {
    console.error('[cron/sync-bison] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
