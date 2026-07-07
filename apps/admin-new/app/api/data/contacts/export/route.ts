import { type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { buildFilterClauses, filtersFromParams, DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

export const dynamic = 'force-dynamic'

// ── Apollo CSV export ───────────────────────────────────────────────────────
// DB-direct. Honors the SAME filters as the contacts list (buildFilterClauses),
// so "filter first, then Apollo Export" gives exactly the rows you're looking
// at — not a region-only dump like the old legacy proxy did.
//
// Paginated: 50k rows per file. The client loops on the X-Has-More /
// X-Next-Offset headers to pull every batch. X-Total-Records is the full count
// so the UI can show progress and an honest "nothing to export" message.
//
// SAFETY GUARD (on by default): only verified-clean, not-opted-out,
// non-hard-bounced emails ever leave in a CSV — Apollo must never receive
// unverified/risky/bounced addresses. Pass includeUnverified=1 to lift it
// (deliberate opt-in, e.g. exporting TO Apollo purely to enrich).
const BATCH = 50000

const CSV_COLS = ['First Name', 'Last Name', 'Email', 'Company Name', 'Website', 'Apollo Contact Id']
const esc = (v: unknown) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`)

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const workspaceId = req.headers.get('x-workspace-id') || sp.get('workspace_id') || DEFAULT_WORKSPACE
  const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0)
  const includeUnverified = sp.get('includeUnverified') === '1'

  try {
    const filters = filtersFromParams(sp)
    const { clauses, params } = buildFilterClauses(filters)
    // Match the list view: keep raw engine-staged leads out unless explicitly asked.
    if (!filters.source) clauses.push(`(source IS DISTINCT FROM 'engine')`)
    // Never export a row with no address.
    clauses.push(`email IS NOT NULL AND email <> ''`)
    // Deliverability guard — on unless explicitly lifted.
    if (!includeUnverified) {
      clauses.push(`LOWER(COALESCE(email_status,'')) IN ('safe','safe_catchall')`)
      clauses.push(`COALESCE(do_not_contact, false) = false`)
      clauses.push(`COALESCE(LOWER(bounce_type),'') <> 'hard'`)
    }
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : ''

    // Total (only needed on the first batch, but cheap enough to always run).
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id = $1${where}`,
      [workspaceId, ...params]
    )
    const total = countRes.rows[0].n as number

    const p = params.length + 2
    const { rows } = await pool.query(
      `SELECT first_name, last_name, email, company_name, company_domain, apollo_id
         FROM contacts WHERE workspace_id = $1${where}
         ORDER BY company_domain NULLS LAST, email
         LIMIT $${p} OFFSET $${p + 1}`,
      [workspaceId, ...params, BATCH, offset]
    )

    const csv = [
      CSV_COLS.join(','),
      ...rows.map((r) => [r.first_name, r.last_name, r.email, r.company_name, r.company_domain, r.apollo_id].map(esc).join(',')),
    ].join('\n')

    const nextOffset = offset + rows.length
    const hasMore = nextOffset < total

    // Stamp exported_to_apollo_at on the rows we just handed out, so the
    // "Not exported to Apollo" filter reflects reality on the next pass.
    if (rows.length) {
      const emails = rows.map((r) => r.email)
      pool.query(
        `UPDATE contacts SET exported_to_apollo_at = NOW()
           WHERE workspace_id = $1 AND email = ANY($2::text[])`,
        [workspaceId, emails]
      ).catch((e) => console.error('[contacts/export] stamp failed:', e))
    }

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="apollo-export-${offset}.csv"`,
        'X-Total-Records': String(total),
        'X-Rows-In-File': String(rows.length),
        'X-Has-More': hasMore ? 'true' : 'false',
        'X-Next-Offset': String(nextOffset),
      },
    })
  } catch (err) {
    console.error('[data/contacts/export]', err)
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Export failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
