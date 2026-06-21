import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { enrichUniboxReply } from '@/lib/enrich'

// Backfill enrichment (signature + contacts DB) for EXISTING Unibox replies that
// predate intake-time enrichment. Runs newest-first, mapped replies only.
//
// GET  ?limit=N        → preview how many would be processed (no writes)
// POST ?limit=N&days=D → enrich up to N replies received in the last D days
//                         (default limit 200, days 30). Admin-only.
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const days = clampInt(new URL(req.url).searchParams.get('days'), 30, 1, 365)
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM unibox_replies
      WHERE workspace_id IS NOT NULL AND lead_email IS NOT NULL
        AND received_at >= NOW() - ($1 || ' days')::interval`,
    [days]
  )
  return NextResponse.json({ candidates: r.rows[0]?.n ?? 0, days })
}

export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000)
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365)

  const rows = await pool.query(
    `SELECT id, workspace_id, lead_email, matched_lead_email, lead_bison_id,
            COALESCE(raw->>'html_body', raw->>'text_body') AS body
       FROM unibox_replies
      WHERE workspace_id IS NOT NULL AND lead_email IS NOT NULL
        AND received_at >= NOW() - ($1 || ' days')::interval
      ORDER BY received_at DESC
      LIMIT $2`,
    [days, limit]
  )

  let enriched = 0
  for (const row of rows.rows) {
    const email = (row.matched_lead_email || row.lead_email) as string | null
    if (!email) continue
    await enrichUniboxReply({
      uniboxId: row.id as string,
      workspaceId: row.workspace_id as string,
      email,
      leadBisonId: (row.lead_bison_id as string | null) ?? null,
      body: (row.body as string | null) ?? null,
    }).then(() => { enriched++ }).catch(() => {})
  }

  return NextResponse.json({ ok: true, processed: rows.rows.length, enriched, limit, days })
}

function clampInt(v: string | null, dflt: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.trunc(n), min), max)
}
