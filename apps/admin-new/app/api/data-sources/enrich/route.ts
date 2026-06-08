import { type NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''
const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY ?? ''

interface EnrichInput {
  place_id: string
  title: string
}

export interface EnrichResult {
  place_id: string
  firstName: string | null
  lastName: string | null
  source: 'companies_house' | 'ai' | null
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

    // CH format: "SURNAME, Firstname Middlename"
    const parts = String(director.name).split(',')
    const lastName = parts[0]?.trim() || null
    const firstName = parts[1]?.trim().split(' ')[0] || null
    return { firstName, lastName }
  } catch {
    return null
  }
}

async function extractNameWithGemini(businessName: string): Promise<{ firstName: string | null; lastName: string | null }> {
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
    return { firstName: parsed.firstName || null, lastName: parsed.lastName || null }
  } catch {
    return { firstName: null, lastName: null }
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const businesses = (body.businesses ?? []) as EnrichInput[]

  const results: EnrichResult[] = []

  for (const biz of businesses) {
    const ch = await lookupCompaniesHouse(biz.title)
    if (ch?.firstName || ch?.lastName) {
      results.push({ place_id: biz.place_id, firstName: ch.firstName, lastName: ch.lastName, source: 'companies_house' })
      continue
    }

    const ai = await extractNameWithGemini(biz.title)
    results.push({
      place_id: biz.place_id,
      firstName: ai.firstName,
      lastName: ai.lastName,
      source: ai.firstName || ai.lastName ? 'ai' : null,
    })
  }

  return NextResponse.json({ results })
}
