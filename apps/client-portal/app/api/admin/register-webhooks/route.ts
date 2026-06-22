import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { registerWebhookAllWorkspaces, BISON_INGEST_ENABLED } from '@/lib/bison'

// Register the Bison reply webhook in EVERY mapped workspace. Bison webhooks are
// per-workspace, so this must run once (after deploy / when a client is added)
// or replies from un-registered workspaces never reach the unibox.
//
// Guarded: we've migrated to PlusVibe, so re-registering Bison webhooks would
// just revive the duplicate firehose. Refuse unless BISON_INGEST_ENABLED is on.
export async function POST() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!BISON_INGEST_ENABLED) {
    return NextResponse.json(
      { ok: false, skipped: true, reason: 'Bison ingestion is disabled (BISON_INGEST_ENABLED off). PlusVibe is the active reply source.' },
      { status: 409 }
    )
  }
  const r = await registerWebhookAllWorkspaces()
  return NextResponse.json(r)
}
