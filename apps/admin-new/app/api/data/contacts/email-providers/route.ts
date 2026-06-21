import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildFilterClauses, filtersFromParams, DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// GET /api/data/contacts/email-providers — TRUE MX provider counts (Google /
// Microsoft / Other / unknown) scoped to the live filter set, with the
// emailProviders filter itself dropped. Port of db.getEmailProviderStats.
export async function GET(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  const filters = filtersFromParams(req.nextUrl.searchParams)
  delete filters.emailProviders

  try {
    const { clauses, params } = buildFilterClauses(filters)
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : ''
    const r = await pool.query(
      `SELECT
        COUNT(CASE WHEN mx_provider = 'email_google'  THEN 1 END)::int as google,
        COUNT(CASE WHEN mx_provider = 'email_outlook' THEN 1 END)::int as outlook,
        COUNT(CASE WHEN mx_provider = 'email_other'   THEN 1 END)::int as other,
        COUNT(CASE WHEN mx_provider IS NULL           THEN 1 END)::int as unknown
      FROM contacts WHERE workspace_id = $1${where}`,
      [workspaceId, ...params]
    )
    const row = r.rows[0] || {}
    return NextResponse.json({
      google: row.google || 0,
      outlook: row.outlook || 0,
      other: row.other || 0,
      unknown: row.unknown || 0,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/email-providers]', message)
    return NextResponse.json({ google: 0, outlook: 0, other: 0, unknown: 0 })
  }
}
