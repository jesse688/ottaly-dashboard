import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { enrichLeadFromContacts } from '@/lib/enrich'

// Bulk-enrich existing leads from our contacts DB (linkedin/industry/location/address/
// seniority/phone we never pushed to Bison). Run after the company-clear so the panel
// fills with the lead's REAL data. Idempotent — safe to re-run.
//
//   /api/admin/enrich-leads                  → all INTERESTED leads, all workspaces
//   /api/admin/enrich-leads?workspace=<pvId> → one workspace
//   /api/admin/enrich-leads?limit=500        → cap (default 5000)
export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

async function run(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const url = new URL(req.url)
  const ws = (url.searchParams.get('workspace') ?? '').trim()
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '5000', 10) || 5000, 1), 20000)

  const leads = await pool.query(
    `SELECT id, workspace_id, email
       FROM esp_leads
      WHERE label = 'INTERESTED' AND email IS NOT NULL
        ${ws ? 'AND workspace_id = $1' : ''}
      ORDER BY updated_at DESC
      LIMIT ${limit}`,
    ws ? [ws] : []
  ).catch((e) => ({ rows: [{ error: String(e) }] as Array<Record<string, string>> }))

  let enriched = 0
  let scanned = 0
  const samples: Array<Record<string, unknown>> = []
  for (const l of leads.rows as Array<{ id: string; workspace_id: string; email: string }>) {
    if (!l.id || !l.workspace_id || !l.email) continue
    scanned++
    const applied = await enrichLeadFromContacts(l.id, l.workspace_id, l.email).catch(() => null)
    if (applied && Object.keys(applied).length) {
      enriched++
      if (samples.length < 6) samples.push({ email: l.email, fields: Object.keys(applied) })
    }
  }

  return NextResponse.json({ ok: true, workspace: ws || 'all', scanned, enriched, samples })
}
