import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const [
      jobTitles,
      industries,
      keywords,
      technologies,
      countries,
      states,
      cities,
      personRegions,
      personCounties,
      personTowns,
      companyCountries,
      companyStates,
      companyCities,
      companyRegions,
      companyCounties,
      companyTowns,
    ] = await Promise.all([
      pool.query(`
        SELECT DISTINCT job_title FROM contacts
        WHERE job_title IS NOT NULL
        ORDER BY job_title
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT industry FROM contacts
        WHERE industry IS NOT NULL
        ORDER BY industry
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT UNNEST(STRING_TO_ARRAY(raw_data->>'Keywords', ',')) AS keyword FROM contacts
        WHERE raw_data->>'Keywords' IS NOT NULL
        ORDER BY keyword
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT UNNEST(STRING_TO_ARRAY(raw_data->>'Technologies', ',')) AS tech FROM contacts
        WHERE raw_data->>'Technologies' IS NOT NULL
        ORDER BY tech
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT country FROM contacts
        WHERE country IS NOT NULL
        ORDER BY country
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT state FROM contacts
        WHERE state IS NOT NULL
        ORDER BY state
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT city FROM contacts
        WHERE city IS NOT NULL
        ORDER BY city
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT person_region FROM contacts
        WHERE person_region IS NOT NULL
        ORDER BY person_region
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT person_county FROM contacts
        WHERE person_county IS NOT NULL
        ORDER BY person_county
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT person_town FROM contacts
        WHERE person_town IS NOT NULL
        ORDER BY person_town
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_country FROM contacts
        WHERE company_country IS NOT NULL
        ORDER BY company_country
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_state FROM contacts
        WHERE company_state IS NOT NULL
        ORDER BY company_state
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_city FROM contacts
        WHERE company_city IS NOT NULL
        ORDER BY company_city
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_region FROM contacts
        WHERE company_region IS NOT NULL
        ORDER BY company_region
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_county FROM contacts
        WHERE company_county IS NOT NULL
        ORDER BY company_county
        LIMIT 5000
      `),
      pool.query(`
        SELECT DISTINCT company_town FROM contacts
        WHERE company_town IS NOT NULL
        ORDER BY company_town
        LIMIT 5000
      `),
    ])

    return NextResponse.json({
      jobTitles: jobTitles.rows.map(r => r.job_title).filter(Boolean),
      industries: industries.rows.map(r => r.industry).filter(Boolean),
      keywords: keywords.rows.map(r => r.keyword?.trim()).filter(Boolean),
      technologies: technologies.rows.map(r => r.tech?.trim()).filter(Boolean),
      countries: countries.rows.map(r => r.country).filter(Boolean),
      states: states.rows.map(r => r.state).filter(Boolean),
      cities: cities.rows.map(r => r.city).filter(Boolean),
      personRegions: personRegions.rows.map(r => r.person_region).filter(Boolean),
      personCounties: personCounties.rows.map(r => r.person_county).filter(Boolean),
      personTowns: personTowns.rows.map(r => r.person_town).filter(Boolean),
      companyCountries: companyCountries.rows.map(r => r.company_country).filter(Boolean),
      companyStates: companyStates.rows.map(r => r.company_state).filter(Boolean),
      companyCities: companyCities.rows.map(r => r.company_city).filter(Boolean),
      companyRegions: companyRegions.rows.map(r => r.company_region).filter(Boolean),
      companyCounties: companyCounties.rows.map(r => r.company_county).filter(Boolean),
      companyTowns: companyTowns.rows.map(r => r.company_town).filter(Boolean),
    })
  } catch (err) {
    console.error('[contacts/distinct-values]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
