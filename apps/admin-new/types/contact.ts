export interface Contact {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  job_title: string | null
  seniority: string | null
  city: string | null
  state: string | null
  country: string | null
  company_city: string | null
  company_state: string | null
  company_country: string | null
  company_region: string | null
  company_county: string | null
  company_town: string | null
  person_region: string | null
  person_county: string | null
  person_town: string | null
  phone: string | null
  linkedin_url: string | null
  company_domain: string | null
  industry: string | null
  num_employees: number | null
  email_provider: string | null
  apollo_id: string | null
  status: string | null
  bounced_at: string | null
  marked_as_lead_at: string | null
  exported_to_apollo_at: string | null
  sent_to_pv_at: string | null
  owns_building: string | null
  works_remote: boolean | null
  do_not_contact: boolean | null
  email_status: string | null
  email_verified_at: string | null
  tags: string | null
  raw_data: Record<string, any> | null
  ch_status: string | null
  ch_insolvency: boolean | null
  ch_charges: boolean | null
  ch_overdue: boolean | null
}

export interface ContactsResponse {
  contacts: Contact[]
  total: number
  page: number
  pageSize: number
}

export interface ContactFilters {
  search?: string
  workspace?: string
  job_title?: string
  industry?: string
  country?: string
  company_country?: string
  status?: string
  page?: number
  pageSize?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}
