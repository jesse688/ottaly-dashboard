import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { inspectWebhooksAllWorkspaces } from '@/lib/bison'

// Read-only: show what Bison webhooks are CURRENTLY registered per workspace —
// the registered URL + events, and whether each points at THIS portal. Use to
// confirm Bison is set to deliver replies to us (and on the right events).
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await inspectWebhooksAllWorkspaces()
  return NextResponse.json(r)
}
