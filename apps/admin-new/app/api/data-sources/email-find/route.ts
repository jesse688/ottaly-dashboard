import { type NextRequest, NextResponse } from 'next/server'

// Proxies to email-finder-local via the legacy server
const LEGACY_URL = (process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk').replace(/\/$/, '')

export async function POST(req: NextRequest) {
  const body = await req.json()

  // contacts: [{firstName, lastName, domain}]
  // When only domain is known, pass empty names — the finder will generate generic patterns (info@, contact@, etc.)
  const contacts = (body.contacts ?? []) as { firstName?: string; lastName?: string; domain: string }[]

  if (!contacts.length) {
    return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  }

  try {
    const res = await fetch(`${LEGACY_URL}/email-finder-tool/api/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts, verify: true, verifier: 'reacher' }),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `Email finder error: ${text}` }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[data-sources/email-find]', err)
    return NextResponse.json({ error: 'Failed to reach email finder' }, { status: 500 })
  }
}
