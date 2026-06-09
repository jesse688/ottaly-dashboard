import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.search
    // Pass through query params with export=1 to get CSV from legacy
    const res = await fetch(`${LEGACY_API}/api/admin/database/contacts${search}&export=1`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'Export failed' }, { status: 502 })
    }
    const csv = await res.text()
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="contacts-export.csv"',
      },
    })
  } catch (err) {
    console.error('[database/contacts/export]', err)
    return NextResponse.json({ error: 'Export failed' }, { status: 502 })
  }
}
