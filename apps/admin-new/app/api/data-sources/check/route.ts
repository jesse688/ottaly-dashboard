import { type NextRequest, NextResponse } from 'next/server'

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN ?? ''
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD ?? ''

const CATEGORY_KEYWORDS: Record<string, string> = {
  financial_planner: 'financial planners',
  accounting_firm: 'accounting firms',
  legal_services: 'legal services',
  real_estate_agency: 'estate agents',
  insurance_agency: 'insurance agencies',
  mortgage_broker: 'mortgage brokers',
  marketing_consultant: 'marketing consultants',
  it_company: 'IT companies',
  construction_company: 'construction companies',
  dentist: 'dentists',
  physiotherapist: 'physiotherapists',
  restaurant: 'restaurants',
  hotel: 'hotels',
  solar_energy_equipment_supplier: 'solar energy companies',
}

interface Filters {
  requireDomain?: boolean
  claimedOnly?: boolean
  requirePhone?: boolean
  minRating?: number
  minReviews?: number
}

export async function POST(req: NextRequest) {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    return NextResponse.json({ error: 'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set' }, { status: 503 })
  }

  const body = await req.json()
  const { category, city, filters } = body as {
    category: string
    city: string
    filters: Filters
  }

  if (!category || !city) {
    return NextResponse.json({ error: 'category and city are required' }, { status: 400 })
  }

  const searchTerm = CATEGORY_KEYWORDS[category] ?? category.replace(/_/g, ' ')
  const keyword = `${searchTerm} in ${city}`

  try {
    const credentials = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64')
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword,
        location_code: 2826,
        language_code: 'en',
        device: 'desktop',
        depth: 20,
      }]),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `DataForSEO error: ${text}` }, { status: res.status })
    }

    const data = await res.json()
    const task = data?.tasks?.[0]

    if (task?.status_code !== 20000) {
      return NextResponse.json({ error: task?.status_message ?? 'DataForSEO task failed' }, { status: 400 })
    }

    const rawItems: Record<string, unknown>[] = task?.result?.[0]?.items ?? []
    const filtered = rawItems.filter(item => {
      if (filters?.requireDomain && !item.domain) return false
      if (filters?.claimedOnly && !item.is_claimed) return false
      if (filters?.requirePhone && !item.phone) return false
      if (filters?.minRating && ((item.rating as Record<string, number>)?.value ?? 0) < filters.minRating) return false
      if (filters?.minReviews && ((item.rating as Record<string, number>)?.votes_count ?? 0) < filters.minReviews) return false
      return true
    })

    return NextResponse.json({ total_count: filtered.length, cost_estimate: 0 })
  } catch (err) {
    console.error('[data-sources/check]', err)
    return NextResponse.json({ error: 'Failed to reach DataForSEO' }, { status: 500 })
  }
}
