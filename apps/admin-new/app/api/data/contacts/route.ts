import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import {
  buildFilterClauses,
  filtersFromParams,
  ALLOWED_SORT,
  DEFAULT_WORKSPACE,
} from '@/lib/contacts-filter'
import { buildEngineLeadsFilter } from '@/app/api/data/engine-leads/route'

// When dataset=engine, the Contacts page browses the autonomous engine's
// output (ottaly_engine_leads) in the same table UI, without copying rows into
// the contacts pool. Engine rows are mapped to the Contact shape so the grid,
// pagination and detail panel render unchanged. Read-only — engine rows have a
// synthetic id (the domain PK) and status 'engine'.
// Load a client's master exclusion lists (client_verticals) from the legacy
// API and turn them into engine-leads WHERE conditions, so a client's excluded
// industries / company sizes / counties / regions are filtered out live.
async function clientExclusionClauses(
  workspaceId: string,
  startIdx: number,
): Promise<{ sql: string; params: unknown[] }> {
  try {
    const base = process.env.LEGACY_API_URL ?? 'http://localhost:3000'
    const res = await fetch(`${base}/api/client-rules/${encodeURIComponent(workspaceId)}`, {
      headers: process.env.ADMIN_KEY ? { 'x-admin-key': process.env.ADMIN_KEY } : {},
    })
    if (!res.ok) return { sql: '', params: [] }
    const data = await res.json()
    const rules = data.rules || data || {}
    const split = (v: unknown) =>
      String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
    const inds = split(rules.excluded_industries)
    const sizes = split(rules.excluded_company_sizes)
    const regions = split([rules.excluded_counties, rules.excluded_cities].filter(Boolean).join(','))

    const clauses: string[] = []
    const params: unknown[] = []
    let i = startIdx
    // Industry: scraped values rarely match the client vocabulary exactly, so
    // exclude if the engine industry CONTAINS any excluded term (case-insens).
    if (inds.length) {
      clauses.push(`(industry IS NULL OR NOT EXISTS (SELECT 1 FROM unnest($${i}::text[]) x WHERE industry ILIKE '%'||x||'%'))`)
      params.push(inds); i++
    }
    // Company size: exact-match the bucket strings.
    if (sizes.length) {
      clauses.push(`(company_size IS NULL OR NOT (company_size = ANY($${i})))`)
      params.push(sizes); i++
    }
    // Location: client excludes counties/cities, but engine only has a coarse
    // `region`. Match by CONTAINMENT both ways so excluding a city/county/region
    // still drops the matching region (e.g. exclude "London" → drops region
    // "London"; exclude region "South East" → drops it). Exact-equality here
    // (the old behaviour) never matched and silently let excluded areas through.
    if (regions.length) {
      clauses.push(`(region IS NULL OR NOT EXISTS (SELECT 1 FROM unnest($${i}::text[]) x WHERE region ILIKE '%'||x||'%' OR x ILIKE '%'||region||'%'))`)
      params.push(regions); i++
    }
    return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params }
  } catch {
    return { sql: '', params: [] }
  }
}

async function engineLeadsAsContacts(sp: URLSearchParams, limit: number, offset: number) {
  const { where, params } = buildEngineLeadsFilter(sp)
  // Apply the selected client's master exclusions, if any.
  const client = sp.get('cooldownWorkspace')
  const excl = client ? await clientExclusionClauses(client, params.length + 1) : { sql: '', params: [] }
  const fullWhere = where + excl.sql
  const allParams = [...params, ...excl.params]
  const [countRes, rowsRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM ottaly_engine_leads ${fullWhere}`, allParams),
    pool.query(
      `SELECT domain, company_name, company_number, email_primary, emails, phones,
              director_name, address, postcode, sic_code, industry, region,
              company_size, linkedin_url, has_products, product_count, platform,
              source, show, promoted_at
       FROM ottaly_engine_leads ${fullWhere}
       ORDER BY promoted_at DESC NULLS LAST
       LIMIT $${allParams.length + 1} OFFSET $${allParams.length + 2}`,
      [...allParams, limit, offset],
    ),
  ])

  const contacts = rowsRes.rows.map((r) => {
    const [first, ...rest] = String(r.director_name || '').trim().split(/\s+/)
    return {
      id: `engine:${r.domain}`,
      workspace_id: 'engine',
      email: r.email_primary || (Array.isArray(r.emails) ? r.emails[0] : '') || '',
      first_name: first || null,
      last_name: rest.join(' ') || null,
      phone: Array.isArray(r.phones) ? r.phones[0] ?? null : null,
      company_name: r.company_name || null,
      company_domain: r.domain || null,
      job_title: r.director_name ? 'Director' : null,
      linkedin_url: r.linkedin_url || null,
      industry: r.industry || null,
      // company_size is a text bucket ("11-50") — surface it as a string for the
      // engine grid's Employees column (display only; not the INT contacts col).
      num_employees: r.company_size || null,
      company_size: r.company_size || null,
      // Engine `region` is a UK region ("South East"), NOT a country. Map it to
      // company_region only — putting it in company_country showed a region
      // under the Country column.
      company_country: null,
      company_region: r.region || null,
      sic_code: r.sic_code || null, // surfaced for the SIC column in engine view
      status: 'engine',
      source: r.source || null,
      // engine-only extras surfaced in the detail panel / raw view
      raw_data: {
        show: r.show, platform: r.platform, has_products: r.has_products,
        product_count: r.product_count, company_number: r.company_number,
        sic_code: r.sic_code, postcode: r.postcode, address: r.address,
        company_size: r.company_size,
        all_emails: r.emails, all_phones: r.phones, promoted_at: r.promoted_at,
      },
    }
  })
  return { contacts, total: countRes.rows[0].count }
}

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

  // Engine-leads dataset: browse ottaly_engine_leads in the Contacts UI.
  if (sp.get('dataset') === 'engine') {
    try {
      // Allow large limits for bulk-select (Select all/N); default page is 50.
      const { contacts, total } = await engineLeadsAsContacts(sp, Math.min(limit, 50000), offset)
      return NextResponse.json({ contacts, total, limit, offset })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Database error'
      console.error('[data/contacts] engine dataset failed:', message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  const sortField = ALLOWED_SORT.includes(filters.sortBy || '')
    ? (filters.sortBy as string)
    : 'created_at'
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC'

  try {
    const { clauses, params } = buildFilterClauses(filters)
    // Keep scraped engine leads (staged for verify+push) OUT of the verified
    // contacts view unless the user explicitly filters source='engine'.
    if (!filters.source) clauses.push(`(source IS DISTINCT FROM 'engine')`)
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
