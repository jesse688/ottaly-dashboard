import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, sha256 } from '@/lib/auth'
import pool from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json() as {
    email?: string
    password?: string
    workspaceId?: string
    companyName?: string
    active?: boolean
    costPerLead?: number
    currency?: string
    spendVisibility?: string
  }

  const sets: string[] = []
  const values: unknown[] = []

  if (body.email !== undefined) { values.push(body.email.toLowerCase()); sets.push(`email = $${values.length}`) }
  if (body.companyName !== undefined) { values.push(body.companyName); sets.push(`company_name = $${values.length}`) }
  if (body.workspaceId !== undefined) { values.push(body.workspaceId); sets.push(`workspace_id = $${values.length}`) }
  if (body.active !== undefined) { values.push(body.active); sets.push(`active = $${values.length}`) }
  if (body.password !== undefined) { values.push(sha256(body.password)); sets.push(`password_hash = $${values.length}`) }
  if (body.costPerLead !== undefined) { values.push(body.costPerLead); sets.push(`cost_per_lead = $${values.length}`) }
  if (body.currency !== undefined) { values.push(body.currency); sets.push(`currency = $${values.length}`) }
  if (body.spendVisibility !== undefined) { values.push(body.spendVisibility); sets.push(`spend_visibility = $${values.length}`) }

  if (!sets.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  await pool.query(`UPDATE portal_clients SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await pool.query('DELETE FROM portal_clients WHERE id = $1', [id])
  return NextResponse.json({ ok: true })
}
