import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// One-off lead-name repair + diagnostic.
//
// Some leads were ingested from Bison with a CORRUPTED split name (e.g. Bison
// stored first_name="Ja" / last_name="onglynn" for "Jason Glynn"). The portal
// copies first_name/last_name verbatim, so the client Leads page shows the bad
// name. Worse, a lead can exist as TWO esp_leads rows for the same email in one
// workspace with DIFFERENT ids — the original bison-id row (corrupted name, what
// the client page reads) and a later `manual_<replyid>` row (blank name, what the
// Unibox "Edit lead details" writes to). So a Unibox edit never reaches the client.
//
// This endpoint operates on ALL esp_leads rows for (workspace_id, lower(email)) at
// once, so both the split-brain rows are fixed together.
//
//   GET  ?workspace=<id>&email=<addr>
//        → list every esp_leads row for that email in that workspace (id, source,
//          first/last name, status, label). Confirms the split-brain before fixing.
//
//   POST { workspace, email, first_name, last_name }
//        → set first_name/last_name on EVERY row for that email+workspace.
//
// Auth: admin session, OR ?secret=<CRON_SECRET> so it can be curled from a script.

function authed(req: NextRequest): Promise<boolean> | boolean {
  const secret = new URL(req.url).searchParams.get('secret')
  if (process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true
  return getAdminSession().then(s => !!s)
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const workspace = url.searchParams.get('workspace')?.trim()
  const email = url.searchParams.get('email')?.trim().toLowerCase()
  if (!workspace || !email) {
    return NextResponse.json({ error: 'workspace and email query params are required' }, { status: 400 })
  }
  const r = await pool.query(
    `SELECT id, source, first_name, last_name, company_name, status, label,
            created_at, updated_at
       FROM esp_leads
      WHERE workspace_id = $1 AND lower(email) = $2
      ORDER BY (source = 'bison') DESC, updated_at DESC`,
    [workspace, email]
  )
  return NextResponse.json({ workspace, email, count: r.rowCount, rows: r.rows })
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as {
    workspace?: string; email?: string; first_name?: string; last_name?: string
  }
  const workspace = body.workspace?.trim()
  const email = body.email?.trim().toLowerCase()
  const first_name = body.first_name?.trim()
  const last_name = body.last_name?.trim()
  if (!workspace || !email || !first_name) {
    return NextResponse.json(
      { error: 'workspace, email and first_name are required (last_name optional)' },
      { status: 400 },
    )
  }
  const r = await pool.query(
    `UPDATE esp_leads
        SET first_name = $3, last_name = $4, updated_at = NOW()
      WHERE workspace_id = $1 AND lower(email) = $2
      RETURNING id, source, first_name, last_name`,
    [workspace, email, first_name, last_name ?? null]
  )
  return NextResponse.json({ ok: true, updated: r.rowCount, rows: r.rows })
}
