import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, sha256 } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await pool.query(`
    SELECT pc.id, pc.email, pc.company_name, pc.workspace_id, pc.active, pc.created_at,
           pc.cost_per_lead,
           w.name AS workspace_name
    FROM portal_clients pc
    LEFT JOIN esp_workspaces w ON w.id = pc.workspace_id AND w.source = 'plusvibe'
    ORDER BY pc.company_name ASC
  `)
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { email, password, workspaceId, companyName, costPerLead } = await req.json() as {
    email: string
    password: string
    workspaceId: string
    companyName: string
    costPerLead?: number
  }

  if (!email || !password || !workspaceId || !companyName) {
    return NextResponse.json({ error: 'All fields required' }, { status: 400 })
  }

  const passwordHash = sha256(password)

  try {
    const res = await pool.query(
      `INSERT INTO portal_clients (email, password_hash, workspace_id, company_name, cost_per_lead)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [email.toLowerCase(), passwordHash, workspaceId, companyName, Number(costPerLead) || 0]
    )
    return NextResponse.json({ ok: true, id: res.rows[0].id })
  } catch (err: unknown) {
    const pgErr = err as { code?: string }
    if (pgErr.code === '23505') {
      return NextResponse.json({ error: 'Email already exists' }, { status: 409 })
    }
    console.error('[admin/clients POST]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
