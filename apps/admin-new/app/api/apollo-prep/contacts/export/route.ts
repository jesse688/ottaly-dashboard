import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams
    const companyRegion = params.get('companyRegion') ?? ''
    const offset = params.get('offset') ?? '0'

    if (!companyRegion) {
      return NextResponse.json({ error: 'companyRegion required' }, { status: 400 })
    }

    const qs = new URLSearchParams({ companyRegion, offset })
    const res = await fetch(`${LEGACY_API}/api/contacts/export?${qs.toString()}`)

    if (!res.ok) {
      return NextResponse.json(
        { error: `Legacy API error: ${res.status}` },
        { status: 502 },
      )
    }

    // Stream the CSV back with the original custom headers intact
    const csv = await res.arrayBuffer()
    const headers = new Headers({
      'Content-Type': 'text/csv',
      'Content-Disposition':
        res.headers.get('Content-Disposition') ??
        `attachment; filename="export-${offset}.csv"`,
      'X-Has-More': res.headers.get('X-Has-More') ?? 'false',
      'X-Next-Offset': res.headers.get('X-Next-Offset') ?? '0',
      'X-Rows-In-File': res.headers.get('X-Rows-In-File') ?? '0',
    })

    return new NextResponse(csv, { status: 200, headers })
  } catch (err) {
    console.error('[apollo-prep/contacts/export]', err)
    return NextResponse.json({ error: 'Failed to export contacts' }, { status: 502 })
  }
}
