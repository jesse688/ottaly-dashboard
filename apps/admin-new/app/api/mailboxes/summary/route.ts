import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface SupplierStats {
  name: string
  total: number
  active: number
  broken: number
  replyRate: number
  bounceRate: number
  warmupPct: number
  authClean: number
  sentPerDay: number
}

export async function GET() {
  try {
    // Fetch mailbox summary from legacy API
    const data = await legacyFetch('/api/admin/mailboxes/summary') as {
      suppliers?: Array<{
        name: string
        total: number
        active: number
        broken: number
        replyRate: number
        bounceRate: number
        warmupPct: number
        authClean: number
        sentPerDay: number
      }>
    }

    const suppliers: SupplierStats[] = (data.suppliers || []).map(s => ({
      name: s.name || 'unassigned',
      total: s.total || 0,
      active: s.active || 0,
      broken: s.broken || 0,
      replyRate: Number(s.replyRate) || 0,
      bounceRate: Number(s.bounceRate) || 0,
      warmupPct: Number(s.warmupPct) || 0,
      authClean: Number(s.authClean) || 0,
      sentPerDay: Number(s.sentPerDay) || 0,
    }))

    return NextResponse.json({ suppliers })
  } catch (err) {
    console.error('[mailboxes/summary]', err)
    return NextResponse.json({ suppliers: [] }, { status: 500 })
  }
}
