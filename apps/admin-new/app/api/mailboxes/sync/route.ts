import { NextResponse } from 'next/server'
import { syncMailboxes } from '@/lib/mailbox-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/mailboxes/sync — run a full mailbox sync (PlusVibe + Postgres merge)
// into mailbox_full. Awaited so the caller gets the result; the page can also
// poll mailbox_sync_state. Used by the "Refresh" button and a cron.
export async function POST() {
  const result = await syncMailboxes()
  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
