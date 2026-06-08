import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

function parseCSVParam(param: string | null): string[] {
  if (!param) return []
  return param.split(',').map(s => s.trim()).filter(Boolean)
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(p.get('page') ?? '1'))
  const pageSize = Math.min(200, parseInt(p.get('pageSize') ?? '50'))
  const offset = (page - 1) * pageSize

  const allowedSort = ['email', 'first_name', 'company_name', 'job_title', 'status', 'created_at', 'seniority']
  const sortBy = allowedSort.includes(p.get('sortBy') ?? '') ? p.get('sortBy') : 'email'
  const sortDir = p.get('sortDir') === 'asc' ? 'ASC' : 'DESC'

  const conditions: string[] = []
  const values: unknown[] = []

  // Basic filters
  const search = p.get('search')?.trim()
  if (search) {
    values.push(`%${search}%`)
    const searchParam = `$${values.length}`
    conditions.push(`(email ILIKE ${searchParam} OR first_name ILIKE ${searchParam} OR last_name ILIKE ${searchParam} OR company_name ILIKE ${searchParam})`)
  }

  const company = p.get('company')?.trim()
  if (company) {
    values.push(`%${company}%`)
    conditions.push(`company_name ILIKE $${values.length}`)
  }

  const status = p.get('status')
  if (status) {
    values.push(status)
    conditions.push(`status = $${values.length}`)
  }

  const chStatus = p.get('chStatus')
  if (chStatus) {
    values.push(chStatus)
    conditions.push(`ch_status = $${values.length}`)
  }

  const ownsBuilding = p.get('ownsBuilding')
  if (ownsBuilding) {
    values.push(ownsBuilding)
    conditions.push(`owns_building = $${values.length}`)
  }

  // Multi-select array filters
  const jobTitles = parseCSVParam(p.get('jobTitles'))
  if (jobTitles.length) {
    values.push(jobTitles)
    conditions.push(`job_title = ANY($${values.length})`)
  }

  const seniority = parseCSVParam(p.get('seniority'))
  if (seniority.length) {
    values.push(seniority)
    conditions.push(`seniority = ANY($${values.length})`)
  }

  const industries = parseCSVParam(p.get('industries'))
  if (industries.length) {
    values.push(industries)
    conditions.push(`industry = ANY($${values.length})`)
  }

  const personCountries = parseCSVParam(p.get('personCountries'))
  if (personCountries.length) {
    values.push(personCountries)
    conditions.push(`country = ANY($${values.length})`)
  }

  const personRegions = parseCSVParam(p.get('personRegions'))
  if (personRegions.length) {
    values.push(personRegions)
    conditions.push(`person_region = ANY($${values.length})`)
  }

  const personCounties = parseCSVParam(p.get('personCounties'))
  if (personCounties.length) {
    values.push(personCounties)
    conditions.push(`person_county = ANY($${values.length})`)
  }

  const personCities = parseCSVParam(p.get('personCities'))
  if (personCities.length) {
    values.push(personCities)
    conditions.push(`city = ANY($${values.length})`)
  }

  const personTowns = parseCSVParam(p.get('personTowns'))
  if (personTowns.length) {
    values.push(personTowns)
    conditions.push(`person_town = ANY($${values.length})`)
  }

  const companyCountries = parseCSVParam(p.get('companyCountries'))
  if (companyCountries.length) {
    values.push(companyCountries)
    conditions.push(`company_country = ANY($${values.length})`)
  }

  const companyRegions = parseCSVParam(p.get('companyRegions'))
  if (companyRegions.length) {
    values.push(companyRegions)
    conditions.push(`company_region = ANY($${values.length})`)
  }

  const companyCounties = parseCSVParam(p.get('companyCounties'))
  if (companyCounties.length) {
    values.push(companyCounties)
    conditions.push(`company_county = ANY($${values.length})`)
  }

  const companyCities = parseCSVParam(p.get('companyCities'))
  if (companyCities.length) {
    values.push(companyCities)
    conditions.push(`company_city = ANY($${values.length})`)
  }

  const companyTowns = parseCSVParam(p.get('companyTowns'))
  if (companyTowns.length) {
    values.push(companyTowns)
    conditions.push(`company_town = ANY($${values.length})`)
  }

  const keywords = parseCSVParam(p.get('keywords'))
  if (keywords.length) {
    const keywordCond = keywords.map((_, i) => {
      values.push(`%${keywords[i]}%`)
      return `raw_data->>'Keywords' ILIKE $${values.length}`
    }).join(' OR ')
    conditions.push(`(${keywordCond})`)
  }

  const technologies = parseCSVParam(p.get('technologies'))
  if (technologies.length) {
    const techCond = technologies.map((_, i) => {
      values.push(`%${technologies[i]}%`)
      return `raw_data->>'Technologies' ILIKE $${values.length}`
    }).join(' OR ')
    conditions.push(`(${techCond})`)
  }

  // Employee count filters
  const employeeBuckets = parseCSVParam(p.get('employeeBuckets'))
  if (employeeBuckets.length) {
    const bucketConditions = employeeBuckets.map(bucket => {
      const [minStr, maxStr] = bucket.split('-')
      const min = parseInt(minStr)
      const max = parseInt(maxStr)
      values.push(min, max)
      return `(num_employees >= $${values.length - 1} AND num_employees <= $${values.length})`
    })
    conditions.push(`(${bucketConditions.join(' OR ')})`)
  }

  const employeeCustomMin = parseInt(p.get('employeeCustomMin') ?? '')
  const employeeCustomMax = parseInt(p.get('employeeCustomMax') ?? '')
  if (!isNaN(employeeCustomMin)) {
    values.push(employeeCustomMin)
    conditions.push(`num_employees >= $${values.length}`)
  }
  if (!isNaN(employeeCustomMax)) {
    values.push(employeeCustomMax)
    conditions.push(`num_employees <= $${values.length}`)
  }

  // Verification filters
  const verificationStatuses = parseCSVParam(p.get('verificationStatuses'))
  if (verificationStatuses.length) {
    values.push(verificationStatuses)
    conditions.push(`email_status = ANY($${values.length})`)
  }

  // Email provider filters
  const emailProviders = parseCSVParam(p.get('emailProviders'))
  if (emailProviders.length) {
    const providerCond = emailProviders.map(provider => {
      values.push(`%email_${provider}%`)
      return `tags ILIKE $${values.length}`
    }).join(' OR ')
    conditions.push(`(${providerCond})`)
  }

  // Boolean filters
  if (p.get('filterRemote') === '1') {
    conditions.push(`works_remote = true`)
  }
  if (p.get('filterExcludeRemote') === '1') {
    conditions.push(`works_remote = false`)
  }
  if (p.get('filterExcludeDNC') === '1') {
    conditions.push(`do_not_contact = false`)
  }
  if (p.get('filterExportedOnly') === '1') {
    conditions.push(`exported_to_apollo_at IS NOT NULL`)
  }
  if (p.get('filterNotExported') === '1') {
    conditions.push(`exported_to_apollo_at IS NULL`)
  }
  if (p.get('filterSentToPV') === '1') {
    conditions.push(`sent_to_pv_at IS NOT NULL`)
  }
  if (p.get('filterNotSentToPV') === '1') {
    conditions.push(`sent_to_pv_at IS NULL`)
  }
  if (p.get('chInsolvency') === '1') {
    conditions.push(`ch_insolvency = true`)
  }
  if (p.get('chCharges') === '1') {
    conditions.push(`ch_charges = true`)
  }
  if (p.get('chOverdue') === '1') {
    conditions.push(`ch_overdue = true`)
  }
  if (p.get('chOnlyEnriched') === '1') {
    conditions.push(`ch_status IS NOT NULL`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, company_name, job_title, seniority,
                city, state, country, company_city, company_state, company_country,
                phone, linkedin_url, company_domain, industry, num_employees,
                status, bounced_at, marked_as_lead_at, exported_to_apollo_at,
                sent_to_pv_at, owns_building, works_remote, do_not_contact,
                email_status, email_verified_at, tags, raw_data,
                person_region, person_county, person_town,
                company_region, company_county, company_town,
                ch_status, ch_insolvency, ch_charges, ch_overdue
         FROM contacts ${where}
         ORDER BY ${sortBy} ${sortDir} NULLS LAST
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM contacts ${where}`, values),
    ])

    return NextResponse.json({
      contacts: dataRes.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      pageSize,
    })
  } catch (err) {
    console.error('[contacts GET]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
