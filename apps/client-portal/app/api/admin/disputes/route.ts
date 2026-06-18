import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

interface DisputeWithContext {
  id: string
  lead_id: string
  client_id: string
  workspace_id: string
  reason: string
  status: string
  admin_note: string | null
  created_at: string
  resolved_at: string | null
  company_name: string
  client_email: string
  first_name: string | null
  last_name: string | null
  lead_email: string | null
  lead_company: string | null
}

// GET — returns all disputes with client and lead info
export async function GET(_req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await pool.query(
    `SELECT d.*,
            pc.company_name,
            pc.email AS client_email,
            l.first_name,
            l.last_name,
            l.email AS lead_email,
            l.company_name AS lead_company
     FROM portal_lead_disputes d
     JOIN portal_clients pc ON pc.id = d.client_id
     JOIN esp_leads l ON l.id = d.lead_id
     ORDER BY d.created_at DESC`
  )

  return NextResponse.json(res.rows as DisputeWithContext[])
}
