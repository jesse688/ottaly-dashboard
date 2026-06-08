import { type NextRequest, NextResponse } from 'next/server'

const BASE = ((process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')) + '/email-finder-tool'

// GET ?id=xxx — download completed job CSV
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const res = await fetch(`${BASE}/api/jobs/${id}/download`)
  if (!res.ok) return NextResponse.json({ error: 'Download failed' }, { status: res.status })
  const text = await res.text()
  return new NextResponse(text, { headers: { 'Content-Type': 'text/csv' } })
}
