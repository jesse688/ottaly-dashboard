import { type NextRequest, NextResponse } from 'next/server'

// ── Recipient MX enrichment ─────────────────────────────────────────────────
// MX enrichment (enrichWorkspaceBuckets) is a stateful, long-running background
// job in the legacy server process: it walks every business-domain recipient,
// does live DNS MX lookups, and classifies Google WS vs Microsoft 365 vs Other,
// writing email_events.provider_bucket. It is NOT reimplemented here — the call
// is forwarded to the legacy server, mirroring POST /api/combo-analysis/enrich-buckets.

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function POST(req: NextRequest) {
  const url = `${LEGACY_API}/api/combo-analysis/enrich-buckets`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: req.headers.get('cookie') ?? '',
      },
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (err) {
    console.error('[combo-analysis/enrich-buckets proxy]', err)
    return NextResponse.json({ error: 'Legacy server unavailable' }, { status: 502 })
  }
}
