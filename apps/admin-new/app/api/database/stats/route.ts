import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface DatabaseStats {
  total: number
  missing_keywords: number
  missing_industry: number
  missing_num_employees: number
  missing_city: number
  total_domains: number
  domains_with_keywords: number
  domains_with_industry: number
  domains_with_employees: number
  domains_with_city: number
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/database/stats') as DatabaseStats
    return NextResponse.json(data)
  } catch (err) {
    console.error('[database/stats]', err)
    return NextResponse.json({ error: 'Failed to fetch database stats' }, { status: 502 })
  }
}
