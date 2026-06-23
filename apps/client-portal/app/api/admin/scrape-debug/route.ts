import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { scrapePhoneFromSite } from '@/lib/scrape-phone'

export const dynamic = 'force-dynamic'

// GET /api/admin/scrape-debug?url=jmdpropertysolutions.co.uk
// Diagnose the website scrape end-to-end against ONE site: does the server's
// fetch reach it, what status/length, and does phone extraction find a number.
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url).searchParams.get('url') || 'jmdpropertysolutions.co.uk'
  const base = (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/+$/, '')

  // Raw fetch diagnostics (mirror lib/scrape-phone fetchPage).
  let fetchInfo: Record<string, unknown> = {}
  try {
    const res = await fetch(base, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OttalyBot/1.0)' }, signal: AbortSignal.timeout(10000), redirect: 'follow' })
    const text = await res.text()
    fetchInfo = {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get('content-type'),
      length: text.length,
      hasDigitsRun: /\d[\d().\-\s]{7,}\d/.test(text),
      sample: text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
    }
  } catch (e) {
    fetchInfo = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }

  const phone = await scrapePhoneFromSite(base).catch(e => `ERR: ${e instanceof Error ? e.message : e}`)
  return NextResponse.json({ url: base, phone, fetchInfo })
}
