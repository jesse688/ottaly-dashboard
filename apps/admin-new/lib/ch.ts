// Shared WHERE-clause builder for Companies House filtering.
// Used by the company list (GET) and the job-queue (POST) so a "Scrape all
// filtered" job targets exactly the rows the user is looking at.

export interface ChFilter {
  q?: string
  sic?: string
  status?: string
  hasWebsite?: 'yes' | 'no' | ''
  scraped?: 'yes' | 'no' | ''
}

export function buildChWhere(f: ChFilter): { where: string; values: string[] } {
  const clauses: string[] = []
  const values: string[] = []
  const add = (v: string) => {
    values.push(v)
    return `$${values.length}`
  }

  if (f.q && f.q.trim()) {
    const p = add(`%${f.q.trim()}%`)
    clauses.push(
      `(c.company_name ILIKE ${p} OR c.company_number ILIKE ${p} OR c.website ILIKE ${p} OR c.postcode ILIKE ${p})`
    )
  }
  if (f.sic && f.sic.trim()) {
    clauses.push(`c.sic_codes ILIKE ${add(`%${f.sic.trim()}%`)}`)
  }
  if (f.status && f.status.trim()) {
    clauses.push(`c.company_status = ${add(f.status.trim())}`)
  }
  if (f.hasWebsite === 'yes') clauses.push(`(c.website IS NOT NULL AND c.website <> '')`)
  if (f.hasWebsite === 'no') clauses.push(`(c.website IS NULL OR c.website = '')`)
  if (f.scraped === 'yes') {
    clauses.push(`EXISTS (SELECT 1 FROM scraped_contacts sc WHERE sc.company_number = c.company_number)`)
  }
  if (f.scraped === 'no') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM scraped_contacts sc WHERE sc.company_number = c.company_number)`)
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  return { where, values }
}
