import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { registerWebhookAllWorkspaces } from '@/lib/bison'

// Register the Bison reply webhook in EVERY mapped workspace. Bison webhooks are
// per-workspace, so this must run once (after deploy / when a client is added)
// or replies from un-registered workspaces never reach the unibox.
export async function POST() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await registerWebhookAllWorkspaces()
  return NextResponse.json(r)
}
