import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const workspaceId = p.get('workspace_id')
  const status = p.get('status')
  const page = Math.max(1, parseInt(p.get('page') ?? '1'))
  const pageSize = 100

  const conditions = ["source = 'plusvibe'"]
  const values: unknown[] = []

  if (workspaceId) { values.push(workspaceId); conditions.push(`workspace_id = $${values.length}`) }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`) }

  const where = `WHERE ${conditions.join(' AND ')}`
  const offset = (page - 1) * pageSize

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, workspace_id, campaign_id, email, first_name, last_name,
                company_name, status, label, first_replied_at, created_at, updated_at
         FROM esp_leads ${where}
         ORDER BY first_replied_at DESC NULLS LAST, created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM esp_leads ${where}`, values),
    ])
    return NextResponse.json({
      leads: dataRes.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      pageSize,
    })
  } catch (err) {
    console.error('[leads]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
