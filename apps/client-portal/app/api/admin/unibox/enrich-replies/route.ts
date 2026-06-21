import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { enrichUniboxReply, enrichReplyWithCH } from '@/lib/enrich'

// Backfill enrichment (signature + contacts DB + Companies House) for EXISTING
// Unibox replies that predate intake-time enrichment. Runs newest-first, mapped
// replies only.
//
// GET  ?limit=N                 → preview how many would be processed (no writes)
// POST ?limit=N&days=D          → enrich up to N replies in the last D days
//      &interested=1            → only POSITIVE replies: classified interested or
//                                  question, or already marked a lead (the ones
//                                  worth a company rundown — excludes not-
//                                  interested / OOO / unsubscribe / warmup / other)
//      &ch=1 (default) / &ch=0  → include / skip the Companies House lookup
//                         (defaults: limit 200, days 30). Admin-only.
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365)
  const interestedOnly = url.searchParams.get('interested') === '1'
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM unibox_replies
      WHERE workspace_id IS NOT NULL AND lead_email IS NOT NULL
        AND received_at >= NOW() - ($1 || ' days')::interval
        ${interestedOnly ? `AND (COALESCE(admin_label, category) IN ('interested', 'question') OR marked_as_lead = TRUE)` : ''}`,
    [days]
  )
  return NextResponse.json({ candidates: r.rows[0]?.n ?? 0, days, interestedOnly })
}

export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000)
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365)
  const interestedOnly = url.searchParams.get('interested') === '1'
  // Companies House lookup is included by default; pass ch=0 to skip it (e.g. to
  // backfill only signature/contacts data without spending CH API calls).
  const withCH = url.searchParams.get('ch') !== '0'
  // Skip replies already CH-matched so re-runs don't redo the lookup.
  const skipMatched = url.searchParams.get('force') !== '1'

  const rows = await pool.query(
    `SELECT id, workspace_id, lead_email, matched_lead_email, lead_bison_id,
            company_name AS reply_company,
            COALESCE(raw->>'html_body', raw->>'text_body') AS body
       FROM unibox_replies
      WHERE workspace_id IS NOT NULL AND lead_email IS NOT NULL
        AND received_at >= NOW() - ($1 || ' days')::interval
        ${interestedOnly ? `AND (COALESCE(admin_label, category) IN ('interested', 'question') OR marked_as_lead = TRUE)` : ''}
        ${withCH && skipMatched ? `AND (enrich_state IS DISTINCT FROM 'matched')` : ''}
      ORDER BY received_at DESC
      LIMIT $2`,
    [days, limit]
  )

  let enriched = 0
  let chMatched = 0
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

    // Companies House rundown — runs AFTER the signature/contacts pass above, so
    // it can use any company_name that step just resolved. Serialized (awaited)
    // to respect CH's rate limit. Best-effort per row.
    if (withCH) {
      await enrichReplyWithCH(row.id as string, {
        email,
        companyName: (row.reply_company as string | null) ?? null,
      }).then(r => { if (r) chMatched++ }).catch(() => {})
    }
  }

  return NextResponse.json({ ok: true, processed: rows.rows.length, enriched, chMatched, limit, days, interestedOnly, withCH })
}

function clampInt(v: string | null, dflt: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.trunc(n), min), max)
}
