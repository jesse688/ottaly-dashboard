import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

// Proxy to the legacy Apollo export. Forwards EVERY query param (region, size,
// industry, sic, keywords, statuses, includeUnverified, the `after` keyset
// cursor, notExportedOnly, etc.) so the Apollo Prep page can export with any
// filter selection — not just the hardcoded region presets. No longer requires
// companyRegion (an unfiltered export is valid).
export async function GET(req: NextRequest) {
  try {
    const qs = req.nextUrl.searchParams.toString()
    const res = await fetch(`${LEGACY_API}/api/contacts/export?${qs}`)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return NextResponse.json(
        { error: body || `Legacy API error: ${res.status}` },
        { status: res.status === 400 ? 400 : 502 },
      )
    }

    // Stream the CSV back with the paging headers intact (keyset + legacy offset).
    const csv = await res.arrayBuffer()
    const headers = new Headers({
      'Content-Type': 'text/csv',
      'Content-Disposition':
        res.headers.get('Content-Disposition') ?? 'attachment; filename="apollo-export.csv"',
      'X-Has-More': res.headers.get('X-Has-More') ?? 'false',
      'X-Next-After': res.headers.get('X-Next-After') ?? '',
      'X-Next-Offset': res.headers.get('X-Next-Offset') ?? '0',
      'X-Rows-In-File': res.headers.get('X-Rows-In-File') ?? '0',
      'X-Total-Records': res.headers.get('X-Total-Records') ?? '0',
    })

    return new NextResponse(csv, { status: 200, headers })
  } catch (err) {
    console.error('[apollo-prep/contacts/export]', err)
    return NextResponse.json({ error: 'Failed to export contacts' }, { status: 502 })
  }
}
