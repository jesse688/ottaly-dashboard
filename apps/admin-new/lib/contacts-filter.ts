// Ported faithfully from db-postgres.js `_buildFilterClauses` (searchContacts).
// Builds a parameterised WHERE fragment for the `contacts` table. $1 is always
// reserved for workspace_id; this builder starts at $2.
//
// Returns { clauses, params } where the caller assembles:
//   WHERE workspace_id = $1 [ AND <clauses joined by AND> ]
// and runs with [workspaceId, ...params].

export const DEFAULT_WORKSPACE = 'ottaly-global'

export interface ContactFilters {
  search?: string
  status?: string
  seniority?: string
  firstName?: string
  lastName?: string
  jobTitle?: string
  jobTitleExclude?: string
  department?: string
  subDepartments?: string
  linkedinUrl?: string
  industry?: string
  industryExclude?: string
  keywords?: string
  keywordsExclude?: string
  technologies?: string
  technologiesExclude?: string
  sicCodes?: string
  website?: string
  companyLinkedin?: string
  city?: string
  state?: string
  country?: string
  companyCity?: string
  companyState?: string
  companyCountry?: string
  companyRegion?: string
  companyCounty?: string
  companyTown?: string
  personRegion?: string
  personCounty?: string
  personTown?: string
  locationNeedsReview?: string
  cityExclude?: string
  stateExclude?: string
  countryExclude?: string
  email?: string
  phone?: string
  company?: string
  tags?: string
  source?: string
  emailStatus?: string
  emailProviders?: string
  excludeMicrosoft?: string | boolean
  gatewayExclude?: string
  gateway?: string
  numEmployeesRanges?: string
  numEmployeesExcludeRanges?: string
  ownsBuilding?: string
  worksRemote?: string
  excludeRemote?: string
  excludeDNC?: string
  notExportedToApollo?: string
  exportedToApollo?: string
  sentToPV?: string
  notSentToPV?: string
  chStatus?: string
  chInsolvency?: string
  chCharges?: string
  chOverdue?: string
  chOnlyEnriched?: string
  vertical?: string
  cooldownWorkspace?: string
  // sort/paging (consumed by caller, not by WHERE)
  sortBy?: string
  sortDir?: string
  maxPerCompany?: number
  [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Param = any

export function buildFilterClauses(filters: ContactFilters): {
  clauses: string[]
  params: Param[]
} {
  const params: Param[] = []
  // $1 reserved for workspace_id, so this counter starts at 2 — mirrors legacy.
  let p = 2
  const clauses: string[] = []

  const like = (col: string, val: string) => {
    clauses.push(`${col} ILIKE $${p++}`)
    params.push(`%${val}%`)
  }
  const eq = (col: string, val: Param) => {
    clauses.push(`${col} = $${p++}`)
    params.push(val)
  }
  const eqMulti = (col: string, val: string) => {
    const values = val.split(',').map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) return
    if (values.length === 1) {
      eq(col, values[0])
      return
    }
    const placeholders = values.map(() => `$${p++}`).join(',')
    clauses.push(`${col} IN (${placeholders})`)
    params.push(...values)
  }

  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordRegex = (values: string[]) => `\\y(${values.map(reEsc).join('|')})\\y`

  const colMulti = (cols: string | string[], val: string) => {
    const values = val.split(',').map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) return
    const colsArr = Array.isArray(cols) ? cols : [cols]
    const orClauses = colsArr.map((c) => `${c} ~* $${p}`)
    clauses.push(`(${orClauses.join(' OR ')})`)
    params.push(wordRegex(values))
    p++
  }
  const colExact = (col: string, val: string) => {
    const values = val.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
    if (!values.length) return
    clauses.push(`LOWER(${col}) = ANY($${p})`)
    params.push(values)
    p++
  }
  const colExclude = (cols: string | string[], val: string) => {
    const values = val.split(',').map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) return
    const colsArr = Array.isArray(cols) ? cols : [cols]
    const perCol = colsArr.map((c) => `(${c} IS NULL OR ${c} !~* $${p})`)
    clauses.push(`(${perCol.join(' AND ')})`)
    params.push(wordRegex(values))
    p++
  }

  const safe = (name: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      console.warn(`[search] filter "${name}" skipped:`, (e as Error).message)
    }
  }

  safe('status', () => {
    if (filters.status) eq('status', filters.status)
  })
  safe('seniority', () => {
    if (filters.seniority) eqMulti('seniority', filters.seniority)
  })
  safe('firstName', () => {
    if (filters.firstName) like('first_name', filters.firstName)
  })
  safe('lastName', () => {
    if (filters.lastName) like('last_name', filters.lastName)
  })
  safe('jobTitle', () => {
    if (filters.jobTitle) colMulti(['job_title', 'job_title_cleaned'], filters.jobTitle)
  })
  safe('jobTitleExclude', () => {
    if (filters.jobTitleExclude)
      colExclude(['job_title', 'job_title_cleaned'], filters.jobTitleExclude)
  })
  safe('department', () => {
    if (filters.department) colMulti('department', filters.department)
  })
  safe('subDepartments', () => {
    if (filters.subDepartments) colMulti('sub_departments', filters.subDepartments)
  })
  safe('linkedinUrl', () => {
    if (filters.linkedinUrl) like('linkedin_url', filters.linkedinUrl)
  })
  safe('industry', () => {
    if (filters.industry) colMulti('industry', filters.industry)
  })
  safe('industryExclude', () => {
    if (filters.industryExclude) colExclude('industry', filters.industryExclude)
  })
  safe('keywords', () => {
    if (!filters.keywords) return
    const values = filters.keywords.split(',').map((v) => v.trim()).filter(Boolean)
    if (!values.length) return
    clauses.push(`COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') ~* $${p}`)
    params.push(wordRegex(values))
    p++
  })
  safe('keywordsExclude', () => {
    if (!filters.keywordsExclude) return
    const values = filters.keywordsExclude.split(',').map((v) => v.trim()).filter(Boolean)
    if (!values.length) return
    clauses.push(
      `(COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') IS NULL OR COALESCE(NULLIF(keywords,''), raw_data->>'Keywords') !~* $${p})`
    )
    params.push(wordRegex(values))
    p++
  })
  safe('technologies', () => {
    if (!filters.technologies) return
    const values = filters.technologies.split(',').map((v) => v.trim()).filter(Boolean)
    if (!values.length) return
    clauses.push(`COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') ~* $${p}`)
    params.push(wordRegex(values))
    p++
  })
  safe('technologiesExclude', () => {
    if (!filters.technologiesExclude) return
    const values = filters.technologiesExclude.split(',').map((v) => v.trim()).filter(Boolean)
    if (!values.length) return
    clauses.push(
      `(COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') IS NULL OR COALESCE(NULLIF(technologies,''), raw_data->>'Technologies') !~* $${p})`
    )
    params.push(wordRegex(values))
    p++
  })
  safe('sicCodes', () => {
    if (!filters.sicCodes) return
    const codes = filters.sicCodes.split(',').map((c) => c.trim()).filter(Boolean)
    if (!codes.length) return
    clauses.push(`ch_sic_codes ~* $${p}`)
    params.push(`(^|,)(${codes.map((c) => c.replace(/[^0-9]/g, '')).join('|')})(,|$)`)
    p++
  })
  safe('website', () => {
    if (filters.website) like('company_domain', filters.website)
  })
  safe('companyLinkedin', () => {
    if (filters.companyLinkedin) like('company_linkedin_url', filters.companyLinkedin)
  })
  safe('city', () => {
    if (filters.city) colMulti('city', filters.city)
  })
  safe('state', () => {
    if (filters.state) colMulti('state', filters.state)
  })
  safe('country', () => {
    if (filters.country) colMulti('country', filters.country)
  })
  safe('companyCity', () => {
    if (filters.companyCity) colMulti('company_city', filters.companyCity)
  })
  safe('companyState', () => {
    if (filters.companyState) colMulti('company_state', filters.companyState)
  })
  safe('companyCountry', () => {
    if (filters.companyCountry) colMulti('company_country', filters.companyCountry)
  })
  safe('companyRegion', () => {
    if (filters.companyRegion) colExact('company_region', filters.companyRegion)
  })
  safe('companyCounty', () => {
    if (filters.companyCounty) colExact('company_county', filters.companyCounty)
  })
  safe('companyTown', () => {
    if (filters.companyTown) colExact('company_town', filters.companyTown)
  })
  safe('personRegion', () => {
    if (filters.personRegion) colExact('person_region', filters.personRegion)
  })
  safe('personCounty', () => {
    if (filters.personCounty) colExact('person_county', filters.personCounty)
  })
  safe('personTown', () => {
    if (filters.personTown) colExact('person_town', filters.personTown)
  })
  safe('locationNeedsReview', () => {
    if (filters.locationNeedsReview === 'true') clauses.push('location_needs_review = true')
  })
  safe('cityExclude', () => {
    if (filters.cityExclude) colExclude(['city', 'company_city'], filters.cityExclude)
  })
  safe('stateExclude', () => {
    if (filters.stateExclude) colExclude(['state', 'company_state'], filters.stateExclude)
  })
  safe('countryExclude', () => {
    if (filters.countryExclude)
      colExclude(['country', 'company_country'], filters.countryExclude)
  })
  safe('email', () => {
    if (filters.email) like('email', filters.email)
  })
  safe('phone', () => {
    if (filters.phone) {
      clauses.push(`(corporate_phone ILIKE $${p} OR company_phone ILIKE $${p})`)
      params.push(`%${filters.phone}%`)
      p++
    }
  })
  safe('company', () => {
    if (filters.company) {
      clauses.push(`(company_name ILIKE $${p} OR company_domain ILIKE $${p})`)
      params.push(`%${filters.company}%`)
      p++
    }
  })
  safe('search', () => {
    if (filters.search) {
      clauses.push(
        `(email ILIKE $${p} OR first_name ILIKE $${p} OR last_name ILIKE $${p} OR company_name ILIKE $${p})`
      )
      params.push(`%${filters.search}%`)
      p++
    }
  })
  safe('tags', () => {
    if (!filters.tags) return
    const values = String(filters.tags).split(',').map((v) => v.trim()).filter(Boolean)
    if (!values.length) return
    clauses.push(`tags && $${p}::text[]`)
    params.push(values)
    p++
  })
  safe('source', () => {
    if (filters.source) eqMulti('source', filters.source)
  })

  safe('emailStatus', () => {
    if (!filters.emailStatus) return
    const statuses = filters.emailStatus.split(',').map((s) => s.trim()).filter(Boolean)
    if (!statuses.length) return
    const ors: string[] = []
    const realStatuses = statuses.filter((s) => s !== 'not_verified')
    if (realStatuses.length) {
      const ph = realStatuses.map(() => `$${p++}`).join(',')
      ors.push(`email_status IN (${ph})`)
      params.push(...realStatuses)
    }
    if (statuses.includes('not_verified')) ors.push(`email_status IS NULL`)
    if (ors.length) clauses.push(`(${ors.join(' OR ')})`)
  })

  safe('emailProviders', () => {
    if (!filters.emailProviders) return
    const providers = filters.emailProviders.split(',').map((x) => x.trim()).filter(Boolean)
    if (!providers.length) return
    const orClauses: string[] = []
    for (const prov of providers) {
      if (prov === 'unknown') {
        orClauses.push(`mx_provider IS NULL`)
      } else {
        orClauses.push(`mx_provider = $${p}`)
        params.push(prov)
        p += 1
      }
    }
    clauses.push(`(${orClauses.join(' OR ')})`)
  })

  safe('excludeMicrosoft', () => {
    if (filters.excludeMicrosoft !== 'true' && filters.excludeMicrosoft !== true) return
    clauses.push(`mx_provider IS NOT NULL AND mx_provider <> 'email_outlook'`)
  })

  safe('gatewayExclude', () => {
    if (!filters.gatewayExclude) return
    const gws = filters.gatewayExclude.split(',').map((g) => g.trim()).filter(Boolean)
    if (!gws.length) return
    clauses.push(`lower(split_part(email,'@',2)) NOT IN (
      SELECT domain FROM gateway_mx_cache WHERE gateway = ANY($${p}))`)
    params.push(gws)
    p += 1
  })
  safe('gateway', () => {
    if (!filters.gateway) return
    const gws = filters.gateway.split(',').map((g) => g.trim()).filter(Boolean)
    if (!gws.length) return
    clauses.push(`lower(split_part(email,'@',2)) IN (
      SELECT domain FROM gateway_mx_cache WHERE gateway = ANY($${p}))`)
    params.push(gws)
    p += 1
  })

  const buckets = (raw: string): string[] => raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bucketOrs = (list: string[]): string[] => {
    const ors: string[] = []
    for (const b of list) {
      if (b === 'unknown') {
        ors.push(`num_employees IS NULL`)
      } else {
        const m = b.match(/^(\d+)\s*-\s*(\d+)?$/) || b.match(/^(\d+)\+$/)
        if (!m) continue
        const lo = parseInt(m[1], 10)
        const hi = m[2] ? parseInt(m[2], 10) : null
        if (hi == null) {
          ors.push(`num_employees >= $${p}`)
          params.push(lo)
          p++
        } else {
          ors.push(`num_employees BETWEEN $${p} AND $${p + 1}`)
          params.push(lo, hi)
          p += 2
        }
      }
    }
    return ors
  }

  safe('numEmployeesRanges', () => {
    if (!filters.numEmployeesRanges) return
    const ors = bucketOrs(buckets(filters.numEmployeesRanges))
    if (ors.length) clauses.push(`(${ors.join(' OR ')})`)
  })
  safe('numEmployeesExcludeRanges', () => {
    if (!filters.numEmployeesExcludeRanges) return
    const ors = bucketOrs(buckets(filters.numEmployeesExcludeRanges))
    if (ors.length) clauses.push(`NOT (${ors.join(' OR ')})`)
  })

  safe('ownsBuilding', () => {
    if (filters.ownsBuilding) {
      clauses.push(`owns_building = $${p++}`)
      params.push(filters.ownsBuilding)
    }
  })
  safe('worksRemote', () => {
    if (filters.worksRemote === 'true') clauses.push(`works_remote = true`)
  })
  safe('excludeRemote', () => {
    if (filters.excludeRemote === 'true')
      clauses.push(`(works_remote IS NULL OR works_remote = false)`)
  })
  safe('excludeDNC', () => {
    if (filters.excludeDNC === 'true')
      clauses.push(`(do_not_contact IS NULL OR do_not_contact = false)`)
  })

  safe('notExportedToApollo', () => {
    if (filters.notExportedToApollo === 'true') clauses.push(`exported_to_apollo_at IS NULL`)
  })
  safe('exportedToApollo', () => {
    if (filters.exportedToApollo === 'true') clauses.push(`exported_to_apollo_at IS NOT NULL`)
  })

  safe('sentToPV', () => {
    if (filters.sentToPV === 'true')
      clauses.push(`COALESCE(emailed_workspaces, '{}'::jsonb) != '{}'::jsonb`)
  })
  safe('notSentToPV', () => {
    if (filters.notSentToPV === 'true')
      clauses.push(`COALESCE(emailed_workspaces, '{}'::jsonb) = '{}'::jsonb`)
  })

  safe('chStatus', () => {
    if (filters.chStatus) {
      clauses.push(`company_status = $${p++}`)
      params.push(filters.chStatus)
    }
  })
  safe('chInsolvency', () => {
    if (filters.chInsolvency === 'true') clauses.push(`ch_has_insolvency = true`)
  })
  safe('chCharges', () => {
    if (filters.chCharges === 'true') clauses.push(`ch_has_charges = true`)
  })
  safe('chOverdue', () => {
    if (filters.chOverdue === 'true') clauses.push(`ch_accounts_overdue = true`)
  })
  safe('chOnlyEnriched', () => {
    if (filters.chOnlyEnriched === 'true') clauses.push(`ch_company_number IS NOT NULL`)
  })

  safe('vertical', () => {
    if (!filters.vertical) return
    const v = filters.vertical
    const today = new Date().toISOString().slice(0, 10)
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(snoozed_verticals, '[]'::jsonb)) AS sv
      WHERE sv->>'vertical' = $${p} AND sv->>'until' >= $${p + 1}
    )`)
    params.push(v, today)
    p += 2
    if (v === 'solar') {
      clauses.push(`owns_building = $${p++}`)
      params.push('yes')
    }
    if (v === 'office_furniture') {
      clauses.push(`(works_remote IS NULL OR works_remote = false)`)
    }
  })

  safe('cooldownWorkspace', () => {
    if (!filters.cooldownWorkspace) return
    const cooloffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    clauses.push(`NOT (
      emailed_workspaces ? $${p}
      AND COALESCE(emailed_workspaces->$${p}->>'last_sent', '') >= $${p + 1}
    )`)
    params.push(filters.cooldownWorkspace, cooloffDate)
    p += 2
  })

  return { clauses, params }
}

// Pull a ContactFilters object out of URLSearchParams using the same keys the
// legacy /contacts/search route accepts (q maps to search).
export function filtersFromParams(sp: URLSearchParams): ContactFilters {
  const g = (k: string) => sp.get(k) || undefined
  return {
    search: g('q'),
    status: g('status'),
    seniority: g('seniority'),
    firstName: g('firstName'),
    lastName: g('lastName'),
    jobTitle: g('jobTitle'),
    jobTitleExclude: g('jobTitleExclude'),
    department: g('department'),
    subDepartments: g('subDepartments'),
    linkedinUrl: g('linkedinUrl'),
    industry: g('industry'),
    industryExclude: g('industryExclude'),
    keywords: g('keywords'),
    keywordsExclude: g('keywordsExclude'),
    technologies: g('technologies'),
    technologiesExclude: g('technologiesExclude'),
    sicCodes: g('sicCodes'),
    website: g('website'),
    companyLinkedin: g('companyLinkedin'),
    city: g('city'),
    state: g('state'),
    country: g('country'),
    companyCity: g('companyCity'),
    companyState: g('companyState'),
    companyCountry: g('companyCountry'),
    companyRegion: g('companyRegion'),
    companyCounty: g('companyCounty'),
    companyTown: g('companyTown'),
    personRegion: g('personRegion'),
    personCounty: g('personCounty'),
    personTown: g('personTown'),
    // Location EXCLUDE filters. buildFilterClauses already supports these
    // (colExclude over person+company columns); they just weren't parsed out of
    // the query string, so the UI toggle had no effect. Employee exclude-ranges
    // were likewise declared but never read.
    cityExclude: g('cityExclude'),
    stateExclude: g('stateExclude'),
    countryExclude: g('countryExclude'),
    numEmployeesExcludeRanges: g('numEmployeesExcludeRanges'),
    locationNeedsReview: g('locationNeedsReview'),
    email: g('email'),
    phone: g('phone'),
    company: g('company'),
    tags: g('tags'),
    source: g('source'),
    emailStatus: g('emailStatus'),
    emailProviders: g('emailProviders'),
    excludeMicrosoft: g('excludeMicrosoft'),
    gatewayExclude: g('gatewayExclude'),
    gateway: g('gateway'),
    numEmployeesRanges: g('numEmployeesRanges'),
    ownsBuilding: g('ownsBuilding'),
    worksRemote: g('worksRemote'),
    excludeRemote: g('excludeRemote'),
    excludeDNC: g('excludeDNC'),
    notExportedToApollo: g('notExportedToApollo'),
    exportedToApollo: g('exportedToApollo'),
    sentToPV: g('sentToPV'),
    notSentToPV: g('notSentToPV'),
    chStatus: g('chStatus'),
    chInsolvency: g('chInsolvency'),
    chCharges: g('chCharges'),
    chOverdue: g('chOverdue'),
    chOnlyEnriched: g('chOnlyEnriched'),
    vertical: g('vertical'),
    cooldownWorkspace: g('cooldownWorkspace'),
    sortBy: g('sortBy'),
    sortDir: g('sortDir'),
    maxPerCompany: Math.max(0, parseInt(g('maxPerCompany') || '0', 10) || 0),
  }
}

export const ALLOWED_SORT = [
  'created_at',
  'email',
  'first_name',
  'last_name',
  'company_name',
  'seniority',
  'status',
  'exported_to_apollo_at',
  'marked_as_lead_at',
  'bounced_at',
  'company_domain',
  'job_title',
]
