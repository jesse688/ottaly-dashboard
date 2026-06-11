import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface AdminClient {
  workspace_id: string
  workspace_name?: string
  username?: string
  contact_name?: string
  contact_email?: string
  price_per_lead?: number
  client_status?: string
}

// GET — clients that exist in the ADMIN dashboard (source of truth) but have no
// portal login yet. The admin dashboard stays the one place clients are created;
// this lets us grant portal access in one click without retyping anything.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const base = process.env.ADMIN_DASH_URL // e.g. https://admin.ottaly.co.uk
  const key = process.env.ADMIN_DASH_KEY
  if (!base || !key) {
    return NextResponse.json({ error: 'ADMIN_DASH_URL / ADMIN_DASH_KEY not configured on the portal.' }, { status: 500 })
  }

  let admins: AdminClient[]
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/admin/clients`, {
      headers: { 'x-admin-key': key },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return NextResponse.json({ error: `Admin dashboard responded ${res.status}` }, { status: 502 })
    admins = await res.json()
  } catch (err) {
    return NextResponse.json({ error: `Could not reach the admin dashboard: ${String(err)}` }, { status: 502 })
  }

  const existing = await pool.query('SELECT workspace_id FROM portal_clients')
  const have = new Set(existing.rows.map(r => r.workspace_id as string))

  const candidates = (admins ?? [])
    .filter(c => c.workspace_id && !have.has(c.workspace_id) && c.client_status !== 'inactive')
    .map(c => ({
      workspaceId: c.workspace_id,
      companyName: c.workspace_name || c.username || '',
      contactName: c.contact_name || '',
      email: (c.contact_email || '').toLowerCase(),
      costPerLead: Number(c.price_per_lead ?? 0),
    }))

  return NextResponse.json({ candidates })
}
