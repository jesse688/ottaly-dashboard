import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// One-off generic cleanup: leads were imported with the AGENCY's OWN company on every
// row (esp_leads.company_name = the client's company, e.g. "Jumping Spider", instead of
// the lead's real company). This NULLs out company_name wherever it equals the agency's
// own company for that workspace — generically, via portal_clients.company_name joined
// on workspace_id (NOT hardcoded to any client). Also strips agency-derived
// company_website/job_title from raw. Once cleared, opening a lead's thread re-extracts
// the lead's REAL details from their reply signature.
//
//   /api/admin/clear-agency-leaddata                  → DRY-RUN (counts only, safe)
//   /api/admin/clear-agency-leaddata?apply=1          → actually clear
//   /api/admin/clear-agency-leaddata?workspace=<pvId> → scope to one workspace
export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

async function run(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const url = new URL(req.url)
  const ws = (url.searchParams.get('workspace') ?? '').trim()
  const apply = url.searchParams.get('apply') === '1'   // default = dry-run

  const wsClause = ws ? 'AND l.workspace_id = $1' : ''
  const args = ws ? [ws] : []

  // Preview: how many leads have company_name == their workspace's agency company.
  const preview = await pool.query(
    `SELECT count(*)::int AS n
       FROM esp_leads l
       JOIN portal_clients pc ON pc.workspace_id = l.workspace_id
      WHERE l.company_name IS NOT NULL
        AND lower(btrim(l.company_name)) = lower(btrim(pc.company_name))
        ${wsClause}`,
    args
  ).catch((e) => ({ rows: [{ n: -1, error: String(e) }] }))

  let companyCleared = 0
  let rawCleared = 0
  if (apply) {
    // 1) NULL company_name where it equals the agency's own company.
    const c = await pool.query(
      `UPDATE esp_leads l
          SET company_name = NULL, updated_at = NOW()
         FROM portal_clients pc
        WHERE pc.workspace_id = l.workspace_id
          AND l.company_name IS NOT NULL
          AND lower(btrim(l.company_name)) = lower(btrim(pc.company_name))
          ${wsClause}`,
      args
    ).catch(() => null)
    companyCleared = c?.rowCount ?? 0

    // 2) Strip company_website / job_title from raw where they embed the agency's
    //    company name (the mis-attributed signature data). Leaves all other raw keys.
    const r = await pool.query(
      `UPDATE esp_leads l
          SET raw = l.raw - 'company_website' - 'job_title', updated_at = NOW()
         FROM portal_clients pc
        WHERE pc.workspace_id = l.workspace_id
          AND (l.raw ? 'company_website' OR l.raw ? 'job_title')
          AND ( lower(coalesce(l.raw->>'company_website','')) LIKE '%' || lower(btrim(pc.company_name)) || '%'
             OR lower(coalesce(l.raw->>'job_title',''))       LIKE '%' || lower(btrim(pc.company_name)) || '%' )
          ${wsClause}`,
      args
    ).catch(() => null)
    rawCleared = r?.rowCount ?? 0
  }

  return NextResponse.json({
    ok: true,
    applied: apply,
    workspace: ws || 'all',
    wouldClear: preview.rows[0]?.n ?? 0,
    companyCleared,
    rawCleared,
    note: apply ? 'Cleared. Open a lead thread to re-extract the real company from the reply signature.'
                : 'DRY RUN — add ?apply=1 to actually clear.',
  })
}
