import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import {
  buildFilterClauses,
  filtersFromParams,
  ALLOWED_SORT,
  DEFAULT_WORKSPACE,
} from '@/lib/contacts-filter'

// GET /api/data/contacts — DB-direct port of legacy /contacts/search
// + searchContacts() / getContactsCount() in db-postgres.js.
// Returns { contacts, total, limit, offset }.

// Columns selected for the results grid. Superset of legacy searchContacts()
// SELECT plus mx_provider (drives the Email Provider column) and raw_data
// (detail panel fallbacks).
const SELECT_COLS = `id, workspace_id, email, first_name, last_name, phone, company_name, company_domain,
  job_title, job_title_cleaned, seniority, department, sub_departments, apollo_id, apollo_person_id,
  linkedin_url, company_linkedin_url, industry, num_employees, keywords, technologies,
  city, state, country, company_address, company_city, company_state, company_country,
  company_region, company_county, company_town, person_region, person_county, person_town,
  location_source, location_needs_review,
  corporate_phone, company_phone, email_status, email_verified_at, mx_provider,
  status, tags, source, do_not_contact, works_remote, owns_building,
  snoozed_verticals, reply_notes, last_reply_at, marked_as_lead_at,
  bounced_at, bounce_type, soft_bounce_count, last_emailed_at, email_count,
  emailed_workspaces, last_campaign_name, pushed_campaigns,
  exported_to_apollo_at, imported_at, created_at, updated_at`

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const workspaceId =
    req.headers.get('x-workspace-id') || sp.get('workspace_id') || DEFAULT_WORKSPACE

  const filters = filtersFromParams(sp)
  const limit = Math.min(parseInt(sp.get('limit') || '50', 10) || 50, 200000)
  const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0)

  const sortField = ALLOWED_SORT.includes(filters.sortBy || '')
    ? (filters.sortBy as string)
    : 'created_at'
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC'

  try {
    const { clauses, params } = buildFilterClauses(filters)
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : ''
    const p = params.length + 2

    let rowsPromise
    if (filters.maxPerCompany && filters.maxPerCompany > 0) {
      const sql = `
        WITH ranked AS (
          SELECT ${SELECT_COLS},
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(COALESCE(company_name, email))
              ORDER BY ${sortField} ${sortDir}
            ) AS _rn
          FROM contacts
          WHERE workspace_id = $1${where}
        )
        SELECT * FROM ranked
        WHERE _rn <= $${p}
        ORDER BY ${sortField} ${sortDir}
        LIMIT $${p + 1} OFFSET $${p + 2}`
      rowsPromise = pool.query(sql, [
        workspaceId,
        ...params,
        filters.maxPerCompany,
        limit,
        offset,
      ])
    } else {
      const sql = `SELECT ${SELECT_COLS}
        FROM contacts WHERE workspace_id = $1${where}
        ORDER BY ${sortField} ${sortDir} LIMIT $${p} OFFSET $${p + 1}`
      rowsPromise = pool.query(sql, [workspaceId, ...params, limit, offset])
    }

    const countPromise = pool.query(
      `SELECT COUNT(*)::int AS count FROM contacts WHERE workspace_id = $1${where}`,
      [workspaceId, ...params]
    )

    const [rowsRes, countRes] = await Promise.all([rowsPromise, countPromise])

    return NextResponse.json({
      contacts: rowsRes.rows,
      total: countRes.rows[0].count,
      limit,
      offset,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts] search failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/data/contacts — create a single contact (the "+ Add" action).
// DB-direct insert into the contacts table. Mirrors legacy POST /api/contacts.
const CREATE_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'phone',
  'linkedin_url',
  'job_title',
  'seniority',
  'department',
  'company_name',
  'company_domain',
  'industry',
  'city',
  'state',
  'country',
  'status',
] as const

export async function POST(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email = String(body.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
  }

  const cols: string[] = ['workspace_id']
  const vals: unknown[] = [workspaceId]
  for (const f of CREATE_FIELDS) {
    const v = body[f]
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      cols.push(f)
      vals.push(f === 'email' ? email : v)
    }
  }
  if (!cols.includes('email')) {
    cols.push('email')
    vals.push(email)
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
  try {
    const r = await pool.query(
      `INSERT INTO contacts (${cols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (workspace_id, email) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id, email`,
      vals
    )
    return NextResponse.json({ contact: r.rows[0] }, { status: 201 })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts] create failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
