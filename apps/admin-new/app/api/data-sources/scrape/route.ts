import { type NextRequest, NextResponse } from 'next/server'

export const maxDuration = 30

interface ScrapeInput {
  place_id: string
  domain: string
}

export interface ScrapeResult {
  place_id: string
  email: string | null
}

const GENERIC_PREFIX = /^(info|contact|hello|admin|support|enquiries|enquiry|mail|office|sales|noreply|no-reply|webmaster|team|general|accounts|invoice|billing|legal|hr|reception|help|post|customerservice|customercare)@/i

function extractBestEmail(html: string, domain: string): string | null {
  // Strip base domain down to registrable domain (handles www.foo.co.uk → foo.co.uk)
  const bare = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  const allMatches = [...html.matchAll(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)]
    .map(m => m[1])
    .filter(e => !e.includes('example') && !e.includes('test@') && e.length < 80)

  // Prefer emails from the company's own domain
  const domainEmails = allMatches.filter(e => e.toLowerCase().includes('@' + bare))
  const personal = domainEmails.filter(e => !GENERIC_PREFIX.test(e))

  return personal[0] ?? domainEmails[0] ?? null
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('text')) return null
    return res.text()
  } catch {
    return null
  }
}

async function scrapeEmail(domain: string): Promise<string | null> {
  const bare = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const base = 'https://' + bare

  // Fetch candidate pages in parallel — stop as soon as we find a personal email
  const paths = ['/contact', '/contact-us', '/about-us', '/about', '/team', '/']
  const pages = await Promise.all(paths.map(p => fetchPage(base + p)))

  // Prefer personal emails, then generic domain emails, across all pages
  let best: string | null = null
  for (const html of pages) {
    if (!html) continue
    const email = extractBestEmail(html, bare)
    if (!email) continue
    if (!GENERIC_PREFIX.test(email)) return email  // personal email — take it immediately
    if (!best) best = email                        // keep best generic as fallback
  }
  return best
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const businesses = (body.businesses ?? []) as ScrapeInput[]

  const results: ScrapeResult[] = await Promise.all(
    businesses.map(async biz => {
      if (!biz.domain) return { place_id: biz.place_id, email: null }
      const email = await scrapeEmail(biz.domain)
      return { place_id: biz.place_id, email }
    })
  )

  return NextResponse.json({ results })
}
