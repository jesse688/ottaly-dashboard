import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1'))
  const pageSize = 50
  const offset = (page - 1) * pageSize

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, company_name, status,
                label, first_replied_at, created_at
         FROM esp_leads
         WHERE workspace_id = $1
           AND source = 'plusvibe'
           AND status IN ('INTERESTED', 'MEETING_BOOKED')
         ORDER BY first_replied_at DESC NULLS LAST, created_at DESC
         LIMIT $2 OFFSET $3`,
        [session.workspaceId, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM esp_leads
         WHERE workspace_id = $1 AND source = 'plusvibe'
           AND status IN ('INTERESTED', 'MEETING_BOOKED')`,
        [session.workspaceId]
      ),
    ])
    return NextResponse.json({
      leads: dataRes.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      pageSize,
    })
  } catch (err) {
    console.error('[portal/leads]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
