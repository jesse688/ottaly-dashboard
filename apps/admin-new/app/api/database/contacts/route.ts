import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface Contact {
  id: string
  workspace_id: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  company_domain: string | null
  job_title: string | null
  industry: string | null
  num_employees: number | null
  keywords: string | null
  technologies: string | null
  company_status: string | null
  city: string | null
  country: string | null
  email_status: string | null
  source: string | null
  imported_at: string | null
  enriched_at: string | null
  ch_company_number: string | null
  ch_company_type: string | null
  ch_founded_year: number | null
  ch_postcode: string | null
  ch_sic_codes: string | null
  ch_jurisdiction: string | null
  ch_has_insolvency: boolean | null
  ch_has_charges: boolean | null
  ch_accounts_overdue: boolean | null
  ch_active_officers: number | null
  ch_resigned_officers: number | null
  ch_address: string | null
  ch_date_of_cessation: string | null
  ch_last_accounts_date: string | null
  ch_year_end_month: number | null
}

export interface ContactsResponse {
  contacts: Contact[]
  total: number
}

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.search
    const data = await legacyFetch(`/api/admin/database/contacts${search}`) as ContactsResponse
    return NextResponse.json(data)
  } catch (err) {
    console.error('[database/contacts GET]', err)
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 502 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = (await req.json()) as { ids: string[] }
    const data = await legacyFetch('/api/admin/database/contacts', {
      method: 'DELETE',
      body: JSON.stringify(body),
    }) as { deleted: number }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[database/contacts DELETE]', err)
    return NextResponse.json({ error: 'Failed to delete contacts' }, { status: 502 })
  }
}
