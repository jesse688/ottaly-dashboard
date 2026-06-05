export interface Contact {
  id: number
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
  phone: string | null
  linkedin_url: string | null
  company_domain: string | null
  industry: string | null
  num_employees: string | null
  email_provider: string | null
  apollo_id: string | null
  status: string | null
  bounced_at: string | null
  marked_as_lead_at: string | null
  exported_to_apollo_at: string | null
  owns_building: boolean | null
  works_remote: boolean | null
  snoozed: boolean | null
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
