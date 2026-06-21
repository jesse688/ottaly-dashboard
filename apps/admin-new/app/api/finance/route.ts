import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// The finance snapshot is sourced from the legacy admin server, which owns the
// authoritative mailbox inventory (live in-memory cache), the SQLite `clients`
// and `managers` tables, plus the Postgres pricing/expenses/revenue tables.
// Those `mailboxes` / `clients` tables do NOT exist in this app's Postgres, so
// we proxy the fully-computed snapshot rather than re-deriving it here.
// `resource` selects which legacy finance resource to read/write through.

function currentMonthStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const resource = searchParams.get('resource') ?? 'snapshot'
  const month = (searchParams.get('month') || currentMonthStr()).slice(0, 7)

  try {
    switch (resource) {
      case 'snapshot':
        return NextResponse.json(await legacyFetch(`/api/finance/snapshot?month=${month}`))
      case 'fx':
        return NextResponse.json(await legacyFetch(`/api/finance/fx-rates?month=${month}`))
      case 'trend':
        return NextResponse.json(await legacyFetch(`/api/finance/trend`))
      case 'expenses':
        return NextResponse.json(await legacyFetch(`/api/finance/expenses`))
      case 'pricing':
        return NextResponse.json(await legacyFetch(`/api/finance/pricing`))
      case 'billing-cycles':
        return NextResponse.json(await legacyFetch(`/api/finance/billing-cycles`))
      case 'manual-entries':
        return NextResponse.json(await legacyFetch(`/api/revenue/manual-entries?month=${month}`))
      case 'clients':
        return NextResponse.json(await legacyFetch(`/api/admin/clients`))
      default:
        return NextResponse.json({ error: `Unknown resource: ${resource}` }, { status: 400 })
    }
  } catch (err) {
    console.error(`[finance GET ${resource}]`, errMessage(err))
    return NextResponse.json({ error: errMessage(err) }, { status: 502 })
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const resource = searchParams.get('resource') ?? ''
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    if (resource === 'expenses') {
      return NextResponse.json(
        await legacyFetch(`/api/finance/expenses`, { method: 'POST', body: JSON.stringify(body) }),
      )
    }
    if (resource === 'manual-entries') {
      return NextResponse.json(
        await legacyFetch(`/api/revenue/manual-entries`, { method: 'POST', body: JSON.stringify(body) }),
      )
    }
    return NextResponse.json({ error: `Unknown resource: ${resource}` }, { status: 400 })
  } catch (err) {
    console.error(`[finance POST ${resource}]`, errMessage(err))
    return NextResponse.json({ error: errMessage(err) }, { status: 502 })
  }
}

export async function PUT(request: Request) {
  const { searchParams } = new URL(request.url)
  const resource = searchParams.get('resource') ?? ''
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    if (resource === 'pricing') {
      return NextResponse.json(
        await legacyFetch(`/api/finance/pricing`, { method: 'PUT', body: JSON.stringify(body) }),
      )
    }
    return NextResponse.json({ error: `Unknown resource: ${resource}` }, { status: 400 })
  } catch (err) {
    console.error(`[finance PUT ${resource}]`, errMessage(err))
    return NextResponse.json({ error: errMessage(err) }, { status: 502 })
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const resource = searchParams.get('resource') ?? ''
  const id = searchParams.get('id') ?? ''

  try {
    if (resource === 'expenses' && id) {
      return NextResponse.json(await legacyFetch(`/api/finance/expenses/${id}`, { method: 'DELETE' }))
    }
    if (resource === 'manual-entries' && id) {
      return NextResponse.json(await legacyFetch(`/api/revenue/manual-entries/${id}`, { method: 'DELETE' }))
    }
    return NextResponse.json({ error: `Unknown resource or missing id: ${resource}` }, { status: 400 })
  } catch (err) {
    console.error(`[finance DELETE ${resource}]`, errMessage(err))
    return NextResponse.json({ error: errMessage(err) }, { status: 502 })
  }
}
