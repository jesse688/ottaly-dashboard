import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { BISON_WARMUP_CODES, buildWarmupRegex } from '@/lib/classify'
import { PV_WARMUP_TAGS } from '@/lib/pv-warmup-tags'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Admin-managed warm-up tag filter.
//   GET                       → terms grouped by source + counts
//   POST  { add: "a\nb,c" }   → add custom terms
//   POST  ?seed=1             → seed the built-in Bison + PlusVibe tags for display
//   POST  ?apply=1            → sweep existing review-unibox rows matching ANY tag
//                               (built-in + custom) into the warm-up folder
//   DELETE ?term=x            → remove a term
async function authed(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  if (process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true
  return !!await getAdminSession()
}

const splitTerms = (s: string) =>
  s.split(/[\n,]+/).map(t => t.trim().toLowerCase()).filter(Boolean)

export async function GET(req: NextRequest) {
  if (!await authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const r = await pool.query(`SELECT term, source FROM unibox_warmup_terms ORDER BY source, term`)
  const bySource: Record<string, string[]> = { bison: [], plusvibe: [], custom: [] }
  for (const row of r.rows) (bySource[row.source as string] ??= []).push(row.term as string)
  return NextResponse.json({
    counts: {
      bison: bySource.bison.length, plusvibe: bySource.plusvibe.length,
      custom: bySource.custom.length, total: r.rows.length,
      builtin_available: BISON_WARMUP_CODES.length + PV_WARMUP_TAGS.length,
    },
    custom: bySource.custom,
    bison: bySource.bison,
    plusvibe: bySource.plusvibe,
  })
}

export async function POST(req: NextRequest) {
  if (!await authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)

  // Seed the built-in defaults into the table so they show in the UI.
  if (url.searchParams.get('seed') === '1') {
    const terms = [
      ...BISON_WARMUP_CODES.map(t => [t.toLowerCase(), 'bison'] as const),
      ...PV_WARMUP_TAGS.map(t => [t.toLowerCase(), 'plusvibe'] as const),
    ]
    const r = await pool.query(
      `INSERT INTO unibox_warmup_terms (term, source)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (term) DO NOTHING`,
      [terms.map(t => t[0]), terms.map(t => t[1])]
    )
    return NextResponse.json({ ok: true, seeded: r.rowCount })
  }

  // Apply: move existing review rows that match ANY warm-up term into the warmup folder.
  if (url.searchParams.get('apply') === '1') {
    const custom = (await pool.query(`SELECT term FROM unibox_warmup_terms WHERE source = 'custom'`)).rows.map(x => x.term as string)
    const re = buildWarmupRegex([...PV_WARMUP_TAGS, ...BISON_WARMUP_CODES, ...custom])
    if (!re) return NextResponse.json({ ok: true, moved: 0, reason: 'no_terms' })
    // Only sweep rows still in the active review surface — never touch done/replies.
    const rows = (await pool.query(
      `SELECT id, subject, body_preview, raw FROM unibox_replies
        WHERE folder IN ('inbox','review','unmapped') LIMIT 20000`
    )).rows
    const hits: string[] = []
    for (const row of rows) {
      let raw = ''
      try { raw = JSON.stringify(row.raw).slice(0, 12000) } catch { /* ignore */ }
      const hay = `${row.subject ?? ''}\n${row.body_preview ?? ''}\n${raw}`
      if (re.test(hay)) hits.push(row.id as string)
    }
    let moved = 0
    for (let i = 0; i < hits.length; i += 200) {
      const chunk = hits.slice(i, i + 200)
      const res = await pool.query(
        `UPDATE unibox_replies SET category='warmup', folder='warmup', classify_state='done',
                ai_model='admin-filter', ai_reasoning='admin warmup tag', updated_at=NOW()
          WHERE id::text = ANY($1::text[])`,
        [chunk]
      )
      moved += res.rowCount ?? 0
    }
    return NextResponse.json({ ok: true, scanned: rows.length, moved })
  }

  // Add custom terms.
  const body = await req.json().catch(() => ({})) as { add?: string }
  const terms = splitTerms(body.add ?? '')
  if (!terms.length) return NextResponse.json({ error: 'no terms' }, { status: 400 })
  const r = await pool.query(
    `INSERT INTO unibox_warmup_terms (term, source)
     SELECT unnest($1::text[]), 'custom' ON CONFLICT (term) DO NOTHING`,
    [terms]
  )
  return NextResponse.json({ ok: true, added: r.rowCount, terms })
}

export async function DELETE(req: NextRequest) {
  if (!await authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const term = new URL(req.url).searchParams.get('term')
  if (!term) return NextResponse.json({ error: 'pass ?term=' }, { status: 400 })
  const r = await pool.query(`DELETE FROM unibox_warmup_terms WHERE term = $1`, [term.toLowerCase()])
  return NextResponse.json({ ok: true, deleted: r.rowCount })
}
