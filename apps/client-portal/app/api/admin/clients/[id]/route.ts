import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, hashCode } from '@/lib/auth'
import pool from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json() as {
    username?: string
    code?: string
    email?: string
    password?: string
    workspaceId?: string
    companyName?: string
    active?: boolean
    costPerLead?: number
    currency?: string
    spendVisibility?: string

    lowLeadsThreshold?: number
    topupBuckets?: { leads: number; pricePerLead: number }[]
    minTopup?: number
  }

  const sets: string[] = []
  const values: unknown[] = []

  if (body.username !== undefined) { values.push(body.username.trim()); sets.push(`username = $${values.length}`) }
  if (body.email !== undefined) { values.push(body.email.toLowerCase() || null); sets.push(`email = $${values.length}`) }
  if (body.companyName !== undefined) { values.push(body.companyName); sets.push(`company_name = $${values.length}`) }
  if (body.workspaceId !== undefined) { values.push(body.workspaceId); sets.push(`workspace_id = $${values.length}`) }
  if (body.active !== undefined) { values.push(body.active); sets.push(`active = $${values.length}`) }
  // Accept either { code } (new) or { password } (legacy) for the access code.
  const newCode = body.code ?? body.password
  if (newCode !== undefined) { values.push(hashCode(newCode)); sets.push(`password_hash = $${values.length}`) }
  if (body.costPerLead !== undefined) { values.push(body.costPerLead); sets.push(`cost_per_lead = $${values.length}`) }
  if (body.currency !== undefined) { values.push(body.currency); sets.push(`currency = $${values.length}`) }
  if (body.spendVisibility !== undefined) { values.push(body.spendVisibility); sets.push(`spend_visibility = $${values.length}`) }
  if (body.lowLeadsThreshold !== undefined) { values.push(Math.max(0, Math.floor(Number(body.lowLeadsThreshold)))); sets.push(`low_leads_threshold = $${values.length}`) }
  if (body.topupBuckets !== undefined) {
    // Sanitise: keep only valid {leads>0, pricePerLead>=0}, sorted by leads asc.
    const clean = (body.topupBuckets ?? [])
      .map(b => ({ leads: Math.floor(Number(b.leads)), pricePerLead: Number(b.pricePerLead) }))
      .filter(b => b.leads > 0 && b.pricePerLead >= 0)
      .sort((a, b) => a.leads - b.leads)
    values.push(JSON.stringify(clean)); sets.push(`topup_buckets = $${values.length}`)
  }
  if (body.minTopup !== undefined) { values.push(Math.max(1, Math.floor(Number(body.minTopup)))); sets.push(`min_topup = $${values.length}`) }

  if (!sets.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  values.push(id)
  try {
    await pool.query(`UPDATE portal_clients SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') return NextResponse.json({ error: 'That username is already taken' }, { status: 409 })
    throw err
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await pool.query('DELETE FROM portal_clients WHERE id = $1', [id])
  return NextResponse.json({ ok: true })
}
