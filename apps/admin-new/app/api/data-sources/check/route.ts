import { type NextRequest, NextResponse } from 'next/server'

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN ?? ''
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD ?? ''
const COST_PER_RECORD = 0.00028

export async function POST(req: NextRequest) {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    return NextResponse.json({ error: 'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set' }, { status: 503 })
  }

  const body = await req.json()
  const { category, lat, lng, radius, filters } = body as {
    category: string
    lat: number
    lng: number
    radius: number
    filters: Record<string, unknown>
  }

  if (!category || !lat || !lng) {
    return NextResponse.json({ error: 'category, lat, and lng are required' }, { status: 400 })
  }

  const builtFilters: [string, string, unknown][] = []
  if (filters?.requireDomain)  builtFilters.push(['domain', '<>', null])
  if (filters?.claimedOnly)    builtFilters.push(['is_claimed', '=', true])
  if (filters?.requirePhone)   builtFilters.push(['phone', '<>', null])
  if (typeof filters?.minRating === 'number' && filters.minRating > 0)
    builtFilters.push(['rating.value', '>=', filters.minRating])
  if (typeof filters?.minReviews === 'number' && filters.minReviews > 0)
    builtFilters.push(['rating.votes_count', '>=', filters.minReviews])

  const payload = [{
    categories: [category],
    location_coordinate: `${lat},${lng},${radius ?? 25}`,
    filters: builtFilters.length ? builtFilters : undefined,
    limit: 1,
  }]

  try {
    const credentials = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64')
    const res = await fetch('https://api.dataforseo.com/v3/business_data/business_listings/search/live', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

    const total_count: number = task?.result?.[0]?.total_count ?? 0
    const cost_estimate = +(total_count * COST_PER_RECORD).toFixed(2)

    return NextResponse.json({ total_count, cost_estimate })
  } catch (err) {
    console.error('[data-sources/check]', err)
    return NextResponse.json({ error: 'Failed to reach DataForSEO' }, { status: 500 })
  }
}
