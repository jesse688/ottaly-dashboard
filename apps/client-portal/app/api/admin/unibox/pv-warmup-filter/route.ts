import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// One-off: filter PV warm-up replies out of the Master Unibox using PlusVibe's
// OWN warm-up filter tags.
//
// Every PV mailbox has a unique "Warmup Filter Tag" (the warmup_custom_words
// field, e.g. "harbor-roadway") that PV injects into the body of EVERY warm-up
// email it sends, precisely so they can be filtered from the inbox. Migrating
// PV->Bison leaked these warm-up replies into our unibox.
//
// So: pull every mailbox's filter tag from all workspaces (/account/list), then
// any unibox reply whose subject/body contains one of those exact tags is a
// warm-up — deterministically, no AI.
//
// GET  ?secret=CRON_SECRET → preview (tag count, matched replies, samples)
// POST ?secret=CRON_SECRET → apply (move matches to the warmup folder)
const PV_BASE = 'https://api.plusvibe.ai/api/v1'

interface PvWorkspace { id: string; name?: string }
interface PvAccount { payload?: { warmup?: { warmup_custom_words?: string } } }

async function pv<T>(path: string): Promise<T> {
  const key = process.env.PLUSVIBE_API_KEY
  if (!key) throw new Error('PLUSVIBE_API_KEY not set')
  const res = await fetch(`${PV_BASE}${path}`, {
    headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`PV ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`)
  return res.json() as Promise<T>
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pull every mailbox's warm-up filter tag across all workspaces.
async function collectFilterTags() {
  const workspaces = await pv<PvWorkspace[]>('/workspaces')
  const tags = new Set<string>()
  const errored: string[] = []
  for (const ws of workspaces) {
    try {
      for (let skip = 0; skip < 10000; skip += 100) {
        const { accounts } = await pv<{ accounts?: PvAccount[] }>(
          `/account/list?workspace_id=${ws.id}&skip=${skip}&limit=100`
        )
        if (!accounts || accounts.length === 0) break
        for (const a of accounts) {
          const tag = (a.payload?.warmup?.warmup_custom_words ?? '').trim().toLowerCase()
          // Guard: must be a real 2+ word filter tag, not blank/single common word.
          if (tag && /[\s\-_]/.test(tag) && tag.length >= 7) tags.add(tag)
        }
        if (accounts.length < 100) break
      }
    } catch (err) {
      errored.push(`${ws.name ?? ws.id}: ${String(err).slice(0, 50)}`)
    }
  }
  return { tags, workspaceCount: workspaces.length, errored }
}

// One regex matching ANY filter tag, tolerant of hyphen/space/underscore between
// the words (PV renders "harbor-roadway" but the body may have "harbor roadway").
function buildTagRegex(tags: Set<string>): RegExp | null {
  const alts = [...tags].map(t =>
    t.split(/[\s\-_]+/).map(escapeRe).join('[\\s\\-_]+')
  )
  if (alts.length === 0) return null
  return new RegExp(`(?:^|[^a-z])(${alts.join('|')})(?:[^a-z]|$)`, 'i')
}

// Rows we never touch even on a tag match.
const SAFE = `
  marked_as_lead = FALSE
  AND admin_label IS NULL
  AND folder NOT IN ('replies', 'warmup')
`

export async function GET(req: NextRequest) { return handle(req, false) }
export async function POST(req: NextRequest) { return handle(req, true) }

async function handle(req: NextRequest, apply: boolean) {
  const url = new URL(req.url)
  const authed = (url.searchParams.get('secret') === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  let collected
  try {
    collected = await collectFilterTags()
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
  const re = buildTagRegex(collected.tags)
  if (!re) {
    return NextResponse.json({ ok: true, note: 'No filter tags returned from PV.', workspaces: collected.workspaceCount })
  }

  // Scan candidate replies (full body) and match the tag regex in JS.
  const rows = await pool.query(
    `SELECT id, folder, lead_email, subject,
            COALESCE(raw->>'text_body', raw->>'html_body', body_preview, '') AS body
       FROM unibox_replies
      WHERE ${SAFE} AND folder IN ('inbox','review','unmapped')`
  )
  const matched: string[] = []
  const byFolder: Record<string, number> = {}
  const samples: { email: string; subject: string; tag: string }[] = []
  for (const r of rows.rows) {
    const hay = `${r.subject ?? ''}\n${r.body ?? ''}`
    const m = re.exec(hay)
    if (!m) continue
    matched.push(r.id as string)
    byFolder[r.folder as string] = (byFolder[r.folder as string] ?? 0) + 1
    if (samples.length < 15) {
      samples.push({ email: r.lead_email as string, subject: (r.subject as string ?? '').slice(0, 60), tag: m[1] })
    }
  }

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      filter_tags_pulled: collected.tags.size,
      workspaces: collected.workspaceCount,
      errored_workspaces: collected.errored,
      replies_scanned: rows.rowCount ?? 0,
      replies_matched: matched.length,
      matched_by_folder: byFolder,
      samples,
    })
  }

  let moved = 0
  if (matched.length) {
    const res = await pool.query(
      `UPDATE unibox_replies
          SET folder = 'warmup', category = 'warmup', classify_state = 'done',
              ai_model = 'pv-filter-tag', ai_reasoning = 'PV warmup filter tag in body',
              updated_at = NOW()
        WHERE id = ANY($1) AND ${SAFE}
        RETURNING id`,
      [matched]
    )
    moved = res.rowCount ?? 0
  }
  return NextResponse.json({
    ok: true,
    mode: 'apply',
    filter_tags_pulled: collected.tags.size,
    replies_moved_to_warmup: moved,
  })
}
