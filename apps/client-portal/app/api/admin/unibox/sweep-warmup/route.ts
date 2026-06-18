import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { detectWarmup } from '@/lib/classify'

// One-off cleanup: scan unibox replies ALREADY in the inbox/review folders for
// warm-up markers (apple-apple etc.) and move the matches to Rejected/warmup.
// The cron filter only catches NEW replies; this clears the existing backlog.
//
// GET  ?limit=500           → preview matches (no changes), so you can eyeball them
// POST ?limit=500           → apply: mark matches category='warmup', folder='rejected'
async function scan(limit: number) {
  // Only consider replies still in a "live" folder — never re-touch done/rejected.
  const res = await pool.query(
    `SELECT u.id, u.subject, u.body_preview,
            (l.raw->>'linkedin_person_url') AS linkedin,
            l.company_name AS lead_company,
            (l.raw->>'job_title') AS job_title,
            (l.raw->>'phone_number') AS phone
       FROM unibox_replies u
       LEFT JOIN LATERAL (
         SELECT company_name, raw FROM esp_leads e
          WHERE e.workspace_id = u.workspace_id AND lower(e.email) = lower(u.lead_email)
          ORDER BY (e.source = 'bison') DESC, e.updated_at DESC LIMIT 1
       ) l ON TRUE
      WHERE u.folder IN ('inbox', 'review')
      ORDER BY u.received_at DESC
      LIMIT $1`,
    [limit]
  )
  const matches: { id: string; subject: string | null; reason: string }[] = []
  for (const r of res.rows) {
    const hasLeadFields = Boolean(r.linkedin || r.job_title || r.phone || r.lead_company)
    const w = detectWarmup({ subject: r.subject ?? '', bodyText: r.body_preview ?? '', hasLeadFields })
    if (w.isWarmup) matches.push({ id: r.id as string, subject: r.subject as string | null, reason: w.reason })
  }
  return { scanned: res.rows.length, matches }
}

export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const limit = Math.min(2000, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 500))
  const { scanned, matches } = await scan(limit)
  return NextResponse.json({ ok: true, mode: 'preview', scanned, matchCount: matches.length, matches: matches.slice(0, 50) })
}

export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const limit = Math.min(2000, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 500))
  const { scanned, matches } = await scan(limit)
  let updated = 0
  for (const m of matches) {
    const r = await pool.query(
      `UPDATE unibox_replies
          SET category = 'warmup', classify_state = 'done', folder = 'rejected',
              ai_model = 'sweep', ai_reasoning = $2, updated_at = NOW()
        WHERE id = $1`,
      [m.id, m.reason]
    )
    updated += r.rowCount ?? 0
  }
  return NextResponse.json({ ok: true, mode: 'apply', scanned, matchCount: matches.length, updated })
}
