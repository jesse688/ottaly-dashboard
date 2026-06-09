import { type NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''
const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY ?? ''
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN ?? ''
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD ?? ''

// Reject placeholder strings Gemini sometimes returns instead of null
const INVALID_NAMES = new Set(['unknown', 'n/a', 'na', 'null', 'none', 'not found', 'not available', 'unavailable', ''])
function validName(name: unknown): string | null {
  if (!name || typeof name !== 'string') return null
  return INVALID_NAMES.has(name.trim().toLowerCase()) ? null : name.trim()
}

interface EnrichInput {
  place_id: string
  title: string
  city?: string | null
}

export interface EnrichResult {
  place_id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  source: 'serp' | 'companies_house' | 'ai' | null
}

// Send all businesses to DataForSEO SERP in one batch, return snippet text per place_id
async function batchSerpLookup(businesses: EnrichInput[]): Promise<Map<string, string>> {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD || !businesses.length) return new Map()

  const tasks = businesses.map(b => ({
    keyword: `"${b.title.replace(/"/g, "'")}" ${b.city ?? 'UK'} director OR founder OR owner`,
    location_code: 2826, // United Kingdom
    language_code: 'en',
    device: 'desktop',
    depth: 10,
  }))

  try {
    const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64')
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(50000),
    })
    if (!res.ok) return new Map()
    const data = await res.json()

    const map = new Map<string, string>()
    businesses.forEach((biz, i) => {
      const items = data.tasks?.[i]?.result?.[0]?.items as Record<string, unknown>[] | undefined
      if (!items) return

      const snippets: string[] = []
      for (const item of items.slice(0, 8)) {
        const type = item.type as string
        if (type === 'ai_overview') {
          for (const block of (item.items as Record<string, unknown>[] ?? [])) {
            if (block.text) snippets.push(String(block.text))
          }
        } else if (type === 'featured_snippet' || type === 'organic' || type === 'knowledge_graph') {
          if (item.description) snippets.push(String(item.description))
          if (type === 'knowledge_graph') {
            for (const el of (item.items as Record<string, unknown>[] ?? [])) {
              if (el.text) snippets.push(String(el.text))
            }
          }
        }
      }

      if (snippets.length) map.set(biz.place_id, snippets.join(' ').slice(0, 2000))
    })

    return map
  } catch {
    return new Map()
  }
}

// Use Gemini to extract name from SERP snippet context
async function extractFromContext(businessName: string, context: string): Promise<{ firstName: string | null; lastName: string | null; email: string | null }> {
  const emailMatch = context.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/)
  const email = emailMatch?.[0] ?? null

  if (!GEMINI_API_KEY) return { firstName: null, lastName: null, email }
  try {
    const prompt = `UK business: "${businessName.replace(/"/g, "'")}"\n\nGoogle search snippets:\n${context}\n\nExtract the owner, founder, or director's first and last name from the snippets above. Return ONLY raw JSON, no markdown: {"firstName":string|null,"lastName":string|null}`
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 80 },
        }),
      }
    )
    if (!res.ok) return { firstName: null, lastName: null, email }
    const data = await res.json()
    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)
    return { firstName: validName(parsed.firstName), lastName: validName(parsed.lastName), email }
  } catch {
    return { firstName: null, lastName: null, email }
  }
}

// Gemini fallback: extract name embedded in the business name string itself
async function extractNameFromTitle(businessName: string): Promise<{ firstName: string | null; lastName: string | null }> {
  if (!GEMINI_API_KEY) return { firstName: null, lastName: null }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Extract an owner/director's first and last name from this UK business name only if a person's name is clearly embedded. Return ONLY raw JSON, no markdown. Format: {"firstName":string|null,"lastName":string|null}. Examples: "J Smith Plumbing"->{"firstName":"J","lastName":"Smith"}, "City Plumbing Ltd"->{"firstName":null,"lastName":null}, "Robert Jones Electrical"->{"firstName":"Robert","lastName":"Jones"}. Business: "${businessName.replace(/"/g, "'")}"` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 60 },
        }),
      }
    )
    if (!res.ok) return { firstName: null, lastName: null }
    const data = await res.json()
    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)
    return { firstName: validName(parsed.firstName), lastName: validName(parsed.lastName) }
  } catch {
    return { firstName: null, lastName: null }
  }
}

async function lookupCompaniesHouse(name: string): Promise<{ firstName: string | null; lastName: string | null } | null> {
  if (!CH_API_KEY) return null
  try {
    const auth = Buffer.from(`${CH_API_KEY}:`).toString('base64')
    const searchRes = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}&items_per_page=3`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!searchRes.ok) return null
    const searchData = await searchRes.json()
    const company = searchData?.items?.[0]
    if (!company?.company_number) return null
    const officersRes = await fetch(
      `https://api.company-information.service.gov.uk/company/${company.company_number}/officers?items_per_page=20`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!officersRes.ok) return null
    const officersData = await officersRes.json()
    const director = (officersData?.items ?? []).find(
      (o: Record<string, unknown>) => o.officer_role === 'director' && !o.resigned_on
    )
    if (!director?.name) return null
    const parts = String(director.name).split(',')
    const lastName = parts[0]?.trim() || null
    const firstName = parts[1]?.trim().split(' ')[0] || null
    return { firstName, lastName }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const businesses = (body.businesses ?? []) as EnrichInput[]

  // Companies House: parallel lookup (only if key configured)
  const chMap = new Map<string, { firstName: string | null; lastName: string | null }>()
  if (CH_API_KEY) {
    await Promise.all(businesses.map(async biz => {
      const ch = await lookupCompaniesHouse(biz.title)
      if (ch?.firstName || ch?.lastName) chMap.set(biz.place_id, ch)
    }))
  }

  // SERP: batch ALL businesses that don't have a CH result in one API call
  const needsSerp = businesses.filter(b => !chMap.has(b.place_id))
  const serpMap = await batchSerpLookup(needsSerp)

  // Gemini: parallel extraction using SERP context (or title-only fallback)
  const results: EnrichResult[] = await Promise.all(businesses.map(async biz => {
    const ch = chMap.get(biz.place_id)
    if (ch) return { place_id: biz.place_id, firstName: ch.firstName, lastName: ch.lastName, email: null, source: 'companies_house' as const }

    const serpText = serpMap.get(biz.place_id)
    if (serpText) {
      const extracted = await extractFromContext(biz.title, serpText)
      if (extracted.firstName || extracted.lastName || extracted.email) {
        return { place_id: biz.place_id, firstName: extracted.firstName, lastName: extracted.lastName, email: extracted.email, source: 'serp' as const }
      }
    }

    // No SERP data — fall back to parsing the business name itself
    const ai = await extractNameFromTitle(biz.title)
    return {
      place_id: biz.place_id,
      firstName: ai.firstName,
      lastName: ai.lastName,
      email: null,
      source: ai.firstName || ai.lastName ? 'ai' as const : null,
    }
  }))

  return NextResponse.json({ results })
}
