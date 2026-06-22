import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// GET /api/data/contacts/distinct-values?field=...&limit=...
// Port of db.getDistinctValues — used to populate the multi-select filter
// option lists (job title, seniority, industry, location hierarchy, …).

const TABLE_COLUMNS: Record<string, string> = {
  job_title: 'job_title',
  jobTitle: 'job_title_cleaned',
  seniority: 'seniority',
  status: 'status',
  company_name: 'company_name',
  company_domain: 'company_domain',
  industry: 'industry',
  city: 'city',
  state: 'state',
  country: 'country',
  company_city: 'company_city',
  company_state: 'company_state',
  company_country: 'company_country',
  company_region: 'company_region',
  company_county: 'company_county',
  company_town: 'company_town',
  person_region: 'person_region',
  person_county: 'person_county',
  person_town: 'person_town',
  department: 'department',
}

const COMMA_FIELDS: Record<string, { col: string; raw: string }> = {
  Keywords: { col: 'keywords', raw: 'Keywords' },
  Technologies: { col: 'technologies', raw: 'Technologies' },
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const field = sp.get('field')
  if (!field) return NextResponse.json({ error: 'field parameter required' }, { status: 400 })
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  const limit = Math.min(parseInt(sp.get('limit') || '5000', 10) || 5000, 10000)

  try {
    const tableCol = TABLE_COLUMNS[field]
    if (tableCol) {
      const r = await pool.query(
        `SELECT ${tableCol} AS value, COUNT(*)::int AS count
         FROM contacts
         WHERE workspace_id = $2 AND ${tableCol} IS NOT NULL AND ${tableCol} != ''
         GROUP BY ${tableCol}
         ORDER BY count DESC, ${tableCol}
         LIMIT $1`,
        [limit, workspaceId]
      )
      return NextResponse.json({
        field,
        values: r.rows.filter((x) => x.value).map((x) => ({ value: x.value, count: x.count })),
      })
    }

    if (COMMA_FIELDS[field]) {
      const { col, raw } = COMMA_FIELDS[field]
      const r = await pool.query(
        `SELECT trim(val) AS value, COUNT(*)::int AS count
         FROM contacts,
           unnest(string_to_array(COALESCE(NULLIF(${col}, ''), raw_data->>'${raw}'), ',')) AS val
         WHERE workspace_id = $2
           AND COALESCE(NULLIF(${col}, ''), raw_data->>'${raw}') IS NOT NULL
           AND trim(val) != ''
         GROUP BY trim(val)
         ORDER BY count DESC
         LIMIT $1`,
        [limit, workspaceId]
      )
      return NextResponse.json({
        field,
        values: r.rows
          .filter((x) => x.value)
          .map((x) => ({ value: String(x.value).trim(), count: x.count })),
      })
    }

    // raw_data JSONB fallback for any CSV column. Title-case the field name.
    const jsonField = field
      .replace('_', ' ')
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    const r = await pool.query(
      `SELECT raw_data->>$3 AS value, COUNT(*)::int AS count
       FROM contacts
       WHERE workspace_id = $2 AND raw_data->>$3 IS NOT NULL AND raw_data->>$3 != ''
       GROUP BY raw_data->>$3
       ORDER BY count DESC, value
       LIMIT $1`,
      [limit, workspaceId, jsonField]
    )
    return NextResponse.json({
      field,
      values: r.rows.filter((x) => x.value).map((x) => ({ value: x.value, count: x.count })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/distinct-values]', message)
    return NextResponse.json({ field, values: [] })
  }
}
