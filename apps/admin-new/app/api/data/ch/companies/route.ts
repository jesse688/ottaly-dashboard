import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Postcode-prefix country filters (CH bulk CountryOfOrigin is unreliable).
function countryCondition(ctry: string): string | null {
  switch (ctry.toUpperCase()) {
    case 'SCOTLAND':
      return `(postcode ILIKE 'AB%' OR postcode ILIKE 'DD%' OR postcode ILIKE 'DG%' OR postcode ILIKE 'EH%' OR postcode ILIKE 'FK%' OR postcode ILIKE 'G%' OR postcode ILIKE 'HS%' OR postcode ILIKE 'IV%' OR postcode ILIKE 'KA%' OR postcode ILIKE 'KW%' OR postcode ILIKE 'KY%' OR postcode ILIKE 'ML%' OR postcode ILIKE 'PA%' OR postcode ILIKE 'PH%' OR postcode ILIKE 'TD%' OR postcode ILIKE 'ZE%')`
    case 'WALES':
      return `(postcode ILIKE 'CF%' OR postcode ILIKE 'LD%' OR postcode ILIKE 'LL%' OR postcode ILIKE 'NP%' OR postcode ILIKE 'SA%' OR postcode ILIKE 'SY%')`
    case 'NORTHERN IRELAND':
      return `postcode ILIKE 'BT%'`
    case 'ENGLAND':
      return `(postcode NOT ILIKE 'AB%' AND postcode NOT ILIKE 'DD%' AND postcode NOT ILIKE 'DG%' AND postcode NOT ILIKE 'EH%' AND postcode NOT ILIKE 'FK%' AND postcode NOT ILIKE 'HS%' AND postcode NOT ILIKE 'IV%' AND postcode NOT ILIKE 'KW%' AND postcode NOT ILIKE 'KY%' AND postcode NOT ILIKE 'ML%' AND postcode NOT ILIKE 'PH%' AND postcode NOT ILIKE 'ZE%' AND postcode NOT ILIKE 'BT%' AND postcode NOT ILIKE 'CF%' AND postcode NOT ILIKE 'LD%' AND postcode NOT ILIKE 'LL%' AND postcode NOT ILIKE 'NP%' AND postcode IS NOT NULL)`
    default:
      return null
  }
}

const SORTABLE: Record<string, string> = {
  company_name: 'c.company_name',
  postcode: 'c.postcode',
  incorporated_on: 'c.incorporated_on',
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1)
  const per_page = Math.min(
    10000,
    Math.max(1, parseInt(searchParams.get('per_page') || '50') || 50)
  )
  const offset = (page - 1) * per_page

  const conditions: string[] = []
  const params: unknown[] = []

  const sic = searchParams.get('sic')
  if (sic) {
    const sicArr = sic.split(',').map((s) => s.trim()).filter(Boolean)
    if (sicArr.length) {
      params.push(sicArr)
      conditions.push(`string_to_array(sic_codes, ',') && $${params.length}::text[]`)
    }
  }
  const postcodePrefix = searchParams.get('postcode_prefix')
  if (postcodePrefix) {
    params.push(postcodePrefix.toUpperCase() + '%')
    conditions.push(`postcode ILIKE $${params.length}`)
  }
  const companyType = searchParams.get('company_type')
  if (companyType) {
    params.push(companyType)
    conditions.push(`company_type ILIKE $${params.length}`)
  }
  const search = searchParams.get('search')
  if (search) {
    params.push('%' + search + '%')
    conditions.push(`company_name ILIKE $${params.length}`)
  }
  const country = searchParams.get('country')
  if (country) {
    const cc = countryCondition(country)
    if (cc) conditions.push(cc)
  }
  const county = searchParams.get('county')
  if (county) {
    params.push(county)
    conditions.push(`UPPER(county) = UPPER($${params.length})`)
  }
  const town = searchParams.get('town')
  if (town) {
    params.push(town)
    conditions.push(`UPPER(post_town) = UPPER($${params.length})`)
  }
  const incAfter = searchParams.get('inc_after')
  if (incAfter) {
    params.push(incAfter)
    conditions.push(`incorporated_on >= $${params.length}`)
  }
  const incBefore = searchParams.get('inc_before')
  if (incBefore) {
    params.push(incBefore)
    conditions.push(`incorporated_on <= $${params.length}`)
  }
  if (searchParams.get('has_email') === 'true') {
    conditions.push(
      `EXISTS (SELECT 1 FROM ch_directors d WHERE d.company_number=ch_companies.company_number AND d.email IS NOT NULL AND d.email_status IN ('safe','safe_catchall'))`
    )
  }
  if (searchParams.get('has_domain') === 'true') {
    conditions.push(`ch_companies.website IS NOT NULL`)
  }
  if (searchParams.get('needs_enrichment') === 'true') {
    conditions.push(
      `(ch_companies.enriched_at IS NULL OR (ch_companies.website IS NULL AND ch_companies.domain_checked_at IS NULL))`
    )
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const sortCol = SORTABLE[searchParams.get('sort') || ''] || 'c.company_name'
  const sortDir = searchParams.get('sort_dir') === 'desc' ? 'DESC' : 'ASC'

  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT c.company_number,c.company_name,c.company_type,c.sic_codes,c.postcode,c.incorporated_on,c.website,c.linkedin,c.employees,c.industry,c.keywords,c.description,c.enriched_at,c.domain_checked_at,
          COUNT(d.id) FILTER (WHERE d.resigned_on IS NULL) AS director_count,
          COUNT(d.id) FILTER (WHERE d.email IS NOT NULL AND d.email_status IN ('safe','safe_catchall')) AS email_count
          FROM ch_companies c LEFT JOIN ch_directors d ON d.company_number=c.company_number ${where} GROUP BY c.company_number ORDER BY ${sortCol} ${sortDir} LIMIT ${per_page} OFFSET ${offset}`,
        params
      ),
      pool.query(`SELECT COUNT(*) as total FROM ch_companies ${where}`, params),
    ])
    return NextResponse.json({
      companies: rows.rows,
      total: Number(count.rows[0].total),
      page,
      per_page,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
