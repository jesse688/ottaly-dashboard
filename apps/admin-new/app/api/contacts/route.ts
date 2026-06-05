import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(p.get('page') ?? '1'))
  const pageSize = Math.min(200, parseInt(p.get('pageSize') ?? '50'))
  const offset = (page - 1) * pageSize
  const search = p.get('search')?.trim()
  const status = p.get('status')
  const country = p.get('country')
  const sortBy = ['email','first_name','company_name','job_title','status'].includes(p.get('sortBy') ?? '')
    ? p.get('sortBy') : 'email'
  const sortDir = p.get('sortDir') === 'desc' ? 'DESC' : 'ASC'

  const conditions: string[] = []
  const values: unknown[] = []

  if (search) {
    values.push(`%${search}%`)
    conditions.push(`(email ILIKE $${values.length} OR first_name ILIKE $${values.length} OR last_name ILIKE $${values.length} OR company_name ILIKE $${values.length})`)
  }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`) }
  if (country) { values.push(country); conditions.push(`country = $${values.length}`) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, company_name, job_title, seniority,
                city, state, country, company_city, company_country, company_region,
                phone, linkedin_url, company_domain, industry, num_employees,
                email_provider, apollo_id, status, bounced_at, marked_as_lead_at,
                exported_to_apollo_at, owns_building, works_remote, snoozed
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
    console.error('[contacts]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
