import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { buildFilterClauses, filtersFromParams, DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// GET /api/data/contacts/employee-counts — bucket counts for the # Employees
// filter, scoped to the live filter set but with numEmployeesRanges dropped so
// each bucket answers "what would I add by ticking this?". Port of
// db.getEmployeeBucketCounts.
export async function GET(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  const filters = filtersFromParams(req.nextUrl.searchParams)
  delete filters.numEmployeesRanges

  try {
    const { clauses, params } = buildFilterClauses(filters)
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : ''
    const r = await pool.query(
      `SELECT
        SUM(CASE WHEN num_employees BETWEEN 1     AND 10    THEN 1 ELSE 0 END) AS "1-10",
        SUM(CASE WHEN num_employees BETWEEN 11    AND 20    THEN 1 ELSE 0 END) AS "11-20",
        SUM(CASE WHEN num_employees BETWEEN 21    AND 50    THEN 1 ELSE 0 END) AS "21-50",
        SUM(CASE WHEN num_employees BETWEEN 51    AND 100   THEN 1 ELSE 0 END) AS "51-100",
        SUM(CASE WHEN num_employees BETWEEN 101   AND 200   THEN 1 ELSE 0 END) AS "101-200",
        SUM(CASE WHEN num_employees BETWEEN 201   AND 500   THEN 1 ELSE 0 END) AS "201-500",
        SUM(CASE WHEN num_employees BETWEEN 501   AND 1000  THEN 1 ELSE 0 END) AS "501-1000",
        SUM(CASE WHEN num_employees BETWEEN 1001  AND 2000  THEN 1 ELSE 0 END) AS "1001-2000",
        SUM(CASE WHEN num_employees BETWEEN 2001  AND 5000  THEN 1 ELSE 0 END) AS "2001-5000",
        SUM(CASE WHEN num_employees BETWEEN 5001  AND 10000 THEN 1 ELSE 0 END) AS "5001-10000",
        SUM(CASE WHEN num_employees >= 10001                THEN 1 ELSE 0 END) AS "10001+",
        SUM(CASE WHEN num_employees IS NULL                 THEN 1 ELSE 0 END) AS "unknown"
      FROM contacts WHERE workspace_id = $1${where}`,
      [workspaceId, ...params]
    )
    const row = r.rows[0] || {}
    const counts: Record<string, number> = {}
    for (const k of Object.keys(row)) counts[k] = parseInt(row[k], 10) || 0
    return NextResponse.json({ counts })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[data/contacts/employee-counts]', message)
    return NextResponse.json({ counts: {} })
  }
}
