import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await pool.query(`
    SELECT w.id, w.name,
           COUNT(c.id) FILTER (WHERE c.status = 'active') AS active_campaigns
    FROM esp_workspaces w
    LEFT JOIN esp_campaigns c ON c.workspace_id = w.id AND c.source IN ('plusvibe', 'bison')
    WHERE w.source IN ('plusvibe', 'bison')
    GROUP BY w.id, w.name
    ORDER BY w.name ASC
  `)
  return NextResponse.json(res.rows)
}
