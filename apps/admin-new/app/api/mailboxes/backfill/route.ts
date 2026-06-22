import { NextResponse } from 'next/server'
import { backfillSupplierDaily } from '@/lib/mailbox-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 800

// POST /api/mailboxes/backfill?days=30 — backfill the supplier/type daily trend
// history from each mailbox's PlusVibe daily chart. Slow (one PV call/mailbox);
// run once to populate the charts without waiting for days of syncs.
export async function POST(req: Request) {
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get('days')) || 30, 1), 90)
  const result = await backfillSupplierDaily(days)
  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
