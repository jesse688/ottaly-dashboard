import { type NextRequest, NextResponse } from 'next/server'
import { buildFilters } from '../filters'

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN ?? ''
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD ?? ''

export interface BusinessResult {
  title: string
  domain: string | null
  phone: string | null
  category: string | null
  city: string | null
  region: string | null
  address: string | null
  rating: number | null
  reviews: number | null
  is_claimed: boolean
  place_id: string
}

export async function POST(req: NextRequest) {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    return NextResponse.json({ error: 'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set' }, { status: 503 })
  }

  const body = await req.json()
  const { category, lat, lng, radius, filters, limit = 1000, offset_token } = body as {
    category: string
    lat: number
    lng: number
    radius: number
    filters: Record<string, unknown>
    limit?: number
    offset_token?: string
  }

  if (!category || !lat || !lng) {
    return NextResponse.json({ error: 'category, lat, and lng are required' }, { status: 400 })
  }

  const taskPayload: Record<string, unknown> = {
    categories: [category],
    location_coordinate: `${lat},${lng},${radius ?? 25}`,
    filters: buildFilters(filters ?? {}),
    order_by: [['rating.votes_count', 'desc']],
    limit: Math.min(limit, 1000),
  }
  if (offset_token) taskPayload.offset_token = offset_token

  try {
    const credentials = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64')
    const res = await fetch('https://api.dataforseo.com/v3/business_data/business_listings/search/live', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([taskPayload]),
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

    const result = task?.result?.[0]
    const items: BusinessResult[] = (result?.items ?? []).map((item: Record<string, unknown>) => {
      const addr = item.address_info as Record<string, string> | null
      const rating = item.rating as Record<string, number> | null
      return {
        title: String(item.title ?? ''),
        domain: (item.domain as string) || null,
        phone: (item.phone as string) || null,
        category: (item.category as string) || null,
        city: addr?.city || null,
        region: addr?.region || null,
        address: addr?.address || null,
        rating: rating?.value ?? null,
        reviews: rating?.votes_count ?? null,
        is_claimed: Boolean(item.is_claimed),
        place_id: String(item.place_id ?? ''),
      }
    })

    return NextResponse.json({
      items,
      total_count: result?.total_count ?? 0,
      next_offset_token: result?.offset_token ?? null,
    })
  } catch (err) {
    console.error('[data-sources/search]', err)
    return NextResponse.json({ error: 'Failed to reach DataForSEO' }, { status: 500 })
  }
}
