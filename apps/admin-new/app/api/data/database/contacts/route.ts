import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Raw contacts-table browser. Ported faithfully from legacy
// GET/DELETE /api/admin/database/contacts.
//   - GET (list): DB-direct paginated read with the exact filter semantics.
//   - GET (export=1): DB-direct CSV stream, same column set as legacy.
//   - DELETE: destructive — PROXIED to the legacy server (not reimplemented).

const ALLOWED_SORT = [
  'email', 'first_name', 'last_name', 'company_name', 'company_domain',
  'job_title', 'industry', 'num_employees', 'keywords', 'city', 'country',
  'email_status', 'source', 'imported_at', 'created_at', 'updated_at', 'enriched_at',
]

// Build the WHERE clause + bound params, mirroring legacy filter logic exactly.
function buildWhere(p: URLSearchParams) {
  const workspace = (p.get('workspace') || '').trim()
  const source = (p.get('source') || '').trim()
  const q = (p.get('q') || '').trim()
  const missing = (p.get('missing') || '').trim()

  const params: unknown[] = []
  const where: string[] = []

  if (workspace) { params.push(workspace); where.push(`workspace_id = $${params.length}`) }
  if (source) { params.push(source); where.push(`source = $${params.length}`) }
  if (q) {
    params.push(`%${q.toLowerCase()}%`)
    const i = params.length
    where.push(
      `(LOWER(email) LIKE $${i} OR LOWER(company_name) LIKE $${i} OR LOWER(first_name) LIKE $${i} OR LOWER(last_name) LIKE $${i})`
    )
  }
  if (missing) {
    for (const f of missing.split(',')) {
      if (f === 'keywords') where.push(`(keywords IS NULL OR keywords = '')`)
      if (f === 'industry') where.push(`(industry IS NULL OR industry = '')`)
      if (f === 'num_employees') where.push(`num_employees IS NULL`)
      if (f === 'city') where.push(`(city IS NULL OR city = '')`)
      if (f === 'technologies') where.push(`(technologies IS NULL OR technologies = '')`)
      if (f === 'linkedin_url') where.push(`(linkedin_url IS NULL OR linkedin_url = '')`)
      if (f === 'company_status') where.push(`company_status IS NULL`)
      if (f === 'ch_company_number') where.push(`ch_company_number IS NULL`)
      if (f === 'ch_founded_year') where.push(`ch_founded_year IS NULL`)
      if (f === 'ch_postcode') where.push(`ch_postcode IS NULL`)
      if (f === 'not_active') where.push(`company_status = 'not active'`)
      if (f === 'ch_insolvency') where.push(`ch_has_insolvency = true`)
      if (f === 'ch_overdue') where.push(`ch_accounts_overdue = true`)
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  return { whereClause, params }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams

  const sortByRaw = p.get('sortBy') || 'imported_at'
  const safeSortBy = ALLOWED_SORT.includes(sortByRaw) ? sortByRaw : 'imported_at'
  const safeSortDir = p.get('sortDir') === 'asc' ? 'ASC' : 'DESC'

  const { whereClause, params } = buildWhere(p)

  try {
    // CSV export branch — identical column set to legacy.
    if (p.get('export') === '1') {
      const cols = [
        'workspace_id', 'email', 'first_name', 'last_name', 'company_name', 'company_domain',
        'job_title', 'industry', 'num_employees', 'keywords', 'technologies', 'company_status',
        'city', 'state', 'country', 'email_status', 'source', 'imported_at',
        'ch_company_number', 'ch_company_type', 'ch_founded_year', 'ch_postcode', 'ch_sic_codes',
        'ch_jurisdiction', 'ch_has_insolvency', 'ch_has_charges', 'ch_accounts_overdue',
        'ch_active_officers', 'ch_resigned_officers', 'ch_address', 'ch_date_of_cessation',
        'ch_last_accounts_date', 'ch_year_end_month',
      ]
      const { rows } = await pool.query(
        `SELECT ${cols.join(',')} FROM contacts ${whereClause} ORDER BY ${safeSortBy} ${safeSortDir}`,
        params
      )
      const esc = (v: unknown) =>
        v == null ? '' : `"${String(v).replace(/"/g, '""')}"`
      const csv = [
        cols.join(','),
        ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
      ].join('\n')
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="contacts-export.csv"',
        },
      })
    }

    const page = parseInt(p.get('page') || '0', 10) || 0
    const limitRaw = parseInt(p.get('limit') || '200', 10) || 200
    const safeLimit = Math.min(limitRaw, 500)
    const offset = page * limitRaw

    const listParams = [...params, safeLimit, offset]
    const [listRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id,workspace_id,email,first_name,last_name,company_name,company_domain,job_title,industry,num_employees,keywords,technologies,company_status,city,country,email_status,mx_provider,source,imported_at,enriched_at,ch_company_number,ch_company_type,ch_founded_year,ch_postcode,ch_sic_codes,ch_jurisdiction,ch_has_insolvency,ch_has_charges,ch_accounts_overdue,ch_active_officers,ch_resigned_officers,ch_address,ch_date_of_cessation,ch_last_accounts_date,ch_year_end_month
         FROM contacts ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortDir}
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      ),
      pool.query(`SELECT COUNT(*) AS count FROM contacts ${whereClause}`, params),
    ])

    return NextResponse.json({
      contacts: listRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[database/contacts] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Destructive — proxied to legacy, which owns the delete + any side effects.
export async function DELETE(req: Request) {
  return proxyToLegacy(req, '/api/admin/database/contacts', { method: 'DELETE' })
}
