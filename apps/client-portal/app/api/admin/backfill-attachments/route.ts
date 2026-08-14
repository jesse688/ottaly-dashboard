import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { ingestAndLink } from '@/lib/attachments'
import type { PVAttachmentRef } from '@/lib/plusvibe'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── Backfill inbound attachments already sitting in portal_emails.raw ────────
//
// Every inbound email ever ingested stored PlusVibe's payload verbatim, so the
// attachment refs are in raw->'out_attachments' — but the bytes were never
// copied, and each `s3_key` is a presigned URL with a ~24h TTL.
//
// THE HONEST LIMIT: anything older than ~24h is already 403 and is NOT
// recoverable from our side. Measured 2026-08-14: of 576 stored parts only 6 were
// still inside the window. This route rescues what is still live and reports the
// rest as expired so the number is visible rather than assumed.
//
// Auth: ?secret=CRON_SECRET (or PORTAL_ADMIN_KEY). ?dry=1 to count without
// fetching. ?ws=<id> one workspace. ?limit=N (default 200) caps emails per run.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') ?? ''
  const expected = process.env.CRON_SECRET ?? process.env.PORTAL_ADMIN_KEY ?? ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const dry = req.nextUrl.searchParams.get('dry') === '1'
  const ws = req.nextUrl.searchParams.get('ws') ?? null
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? 200), 1), 1000)

  // Candidates: inbound emails carrying PV attachment refs that we have not
  // already copied. Newest first — those are the ones whose presigns may still be
  // valid, so the useful work happens before any time budget runs out.
  const rows = await pool.query(
    `SELECT e.id, e.workspace_id, e.timestamp_created, e.raw->'out_attachments' AS parts
       FROM portal_emails e
      WHERE e.direction = 'IN'
        AND jsonb_typeof(e.raw->'out_attachments') = 'array'
        AND jsonb_array_length(e.raw->'out_attachments') > 0
        AND ($1::text IS NULL OR e.workspace_id = $1)
        AND NOT EXISTS (SELECT 1 FROM portal_attachments pa WHERE pa.email_id = e.id)
      ORDER BY e.timestamp_created DESC
      LIMIT $2`,
    [ws, limit],
  )

  // A presign is worth attempting only inside its ~24h life. Anything older is
  // counted as expired rather than fetched — 400 doomed HTTP calls would burn the
  // whole run to learn what the timestamp already tells us.
  const LIVE_MS = 23 * 60 * 60 * 1000
  const now = Date.now()
  let attempted = 0, stored = 0, expired = 0, failed = 0

  if (dry) {
    for (const r of rows.rows) {
      const age = now - new Date(r.timestamp_created as string).getTime()
      const n = Array.isArray(r.parts) ? (r.parts as PVAttachmentRef[]).length : 0
      if (age > LIVE_MS) expired += n; else attempted += n
    }
    return NextResponse.json({
      dry: true, candidate_emails: rows.rows.length,
      recoverable_files: attempted, expired_files: expired,
      note: 'Expired files cannot be recovered — PlusVibe presigns last ~24h.',
    })
  }

  const DEADLINE = now + 240_000
  for (const r of rows.rows) {
    if (Date.now() > DEADLINE) break
    const age = now - new Date(r.timestamp_created as string).getTime()
    const parts = Array.isArray(r.parts) ? (r.parts as PVAttachmentRef[]) : []
    if (age > LIVE_MS) { expired += parts.length; continue }
    attempted += parts.length
    try {
      const n = await ingestAndLink(r.id as string, r.workspace_id as string, { out_attachments: parts })
      stored += n
      failed += Math.max(0, parts.length - n)
    } catch (err) {
      console.error('[backfill-attachments] failed', r.id, err)
      failed += parts.length
    }
  }

  return NextResponse.json({
    candidate_emails: rows.rows.length,
    attempted, stored, failed, expired,
    note: expired
      ? `${expired} file(s) had expired presigned URLs and are not recoverable.`
      : undefined,
  })
}
