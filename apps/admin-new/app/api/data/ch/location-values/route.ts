import { NextResponse } from 'next/server'
import pool from '@/lib/db'

function countryClause(ctry: string | null): string | null {
  const c = (ctry || '').toUpperCase()
  if (c === 'SCOTLAND')
    return `(postcode ILIKE 'AB%' OR postcode ILIKE 'DD%' OR postcode ILIKE 'EH%' OR postcode ILIKE 'FK%' OR postcode ILIKE 'G%' OR postcode ILIKE 'HS%' OR postcode ILIKE 'IV%' OR postcode ILIKE 'KW%' OR postcode ILIKE 'KY%' OR postcode ILIKE 'ML%' OR postcode ILIKE 'PH%' OR postcode ILIKE 'ZE%')`
  if (c === 'WALES')
    return `(postcode ILIKE 'CF%' OR postcode ILIKE 'LD%' OR postcode ILIKE 'LL%' OR postcode ILIKE 'NP%' OR postcode ILIKE 'SA%' OR postcode ILIKE 'SY%')`
  if (c === 'NORTHERN IRELAND') return `postcode ILIKE 'BT%'`
  return null
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const country = searchParams.get('country')
  const county = searchParams.get('county')
  try {
    let rows: string[]
    if (type === 'county') {
      const cc = countryClause(country)
      const base = `county IS NOT NULL AND LENGTH(TRIM(county)) >= 3`
      const where = cc ? `WHERE ${base} AND ${cc}` : `WHERE ${base}`
      const result = await pool.query(
        `SELECT DISTINCT INITCAP(TRIM(county)) AS val FROM ch_companies ${where} ORDER BY val LIMIT 500`
      )
      rows = result.rows.map((r) => r.val).filter((v: string) => v && /^[A-Za-z]/.test(v))
    } else if (type === 'town') {
      const conditions = ['post_town IS NOT NULL', "post_town != ''"]
      const params: unknown[] = []
      if (country) {
        const cc = countryClause(country)
        if (cc) conditions.push(cc)
      }
      if (county) {
        params.push(county)
        conditions.push(`UPPER(county)=UPPER($${params.length})`)
      }
      const result = await pool.query(
        `SELECT DISTINCT INITCAP(post_town) AS val FROM ch_companies WHERE ${conditions.join(' AND ')} ORDER BY val LIMIT 1000`,
        params
      )
      rows = result.rows.map((r) => r.val)
    } else {
      return NextResponse.json({ error: 'type must be county or town' }, { status: 400 })
    }
    return NextResponse.json({ values: rows })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
