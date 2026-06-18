import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Filter warm-up replies out of the Master Unibox using PlusVibe's OWN data.
//
// Warm-up traffic is our own mailboxes emailing each other. So: pull every
// mailbox address from every PV workspace, then any unibox reply whose sender is
// one of those mailboxes is warm-up — deterministically, no AI guessing.
//
// GET  ?secret=CRON_SECRET → preview: how many mailboxes + how many replies match
// POST ?secret=CRON_SECRET → apply: move matched replies to the warmup folder
//
// ?warmupOnly=true restricts the mailbox set to warmup-enabled accounts only.
const PV_BASE = 'https://api.plusvibe.ai/api/v1'

interface PvWorkspace { id: string; name?: string }
interface PvAccount { email?: string; warmup_status?: string }

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

// Every mailbox address across all workspaces (lowercased). Optionally restricted
// to warmup-enabled accounts.
async function collectMailboxes(warmupOnly: boolean) {
  const workspaces = await pv<PvWorkspace[]>('/workspaces')
  const emails = new Set<string>()
  let warmupEnabled = 0
  for (const ws of workspaces) {
    for (let skip = 0; skip < 10000; skip += 100) {
      const { accounts } = await pv<{ accounts?: PvAccount[] }>(
        `/account/list?workspace_id=${ws.id}&skip=${skip}&limit=100`
      )
      if (!accounts || accounts.length === 0) break
      for (const a of accounts) {
        const email = (a.email ?? '').toLowerCase().trim()
        if (!email) continue
        const isWarmup = !!a.warmup_status && !/disabled|off|none|paused/i.test(a.warmup_status)
        if (isWarmup) warmupEnabled++
        if (!warmupOnly || isWarmup) emails.add(email)
      }
      if (accounts.length < 100) break
    }
  }
  return { emails, workspaceCount: workspaces.length, warmupEnabled }
}

// Replies we will NOT touch even if the sender is one of our mailboxes.
const SAFE = `
  marked_as_lead = FALSE
  AND admin_label IS NULL
  AND folder <> 'replies'
  AND folder <> 'warmup'
`

export async function GET(req: NextRequest) {
  return handle(req, false)
}
export async function POST(req: NextRequest) {
  return handle(req, true)
}

async function handle(req: NextRequest, apply: boolean) {
  const url = new URL(req.url)
  const authed = (url.searchParams.get('secret') === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const warmupOnly = url.searchParams.get('warmupOnly') === 'true'

  let mailboxes
  try {
    mailboxes = await collectMailboxes(warmupOnly)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }
  const emailList = [...mailboxes.emails]
  if (emailList.length === 0) {
    return NextResponse.json({
      ok: true,
      note: 'No mailboxes returned from PV — are the workspaces enabled for this API key?',
      workspaces_seen: mailboxes.workspaceCount,
    })
  }

  if (!apply) {
    // How many unibox replies were sent FROM one of our mailboxes, split by folder.
    const match = await pool.query(
      `SELECT folder, COUNT(*)::int n FROM unibox_replies
        WHERE lower(sender_email) = ANY($1) AND ${SAFE}
        GROUP BY folder ORDER BY n DESC`,
      [emailList]
    )
    const total = match.rows.reduce((s, r) => s + (r.n as number), 0)
    return NextResponse.json({
      ok: true,
      mode: 'preview',
      warmupOnly,
      workspaces: mailboxes.workspaceCount,
      mailboxes_in_set: emailList.length,
      warmup_enabled_mailboxes: mailboxes.warmupEnabled,
      replies_matched: total,
      matched_by_folder: match.rows,
    })
  }

  const moved = await pool.query(
    `UPDATE unibox_replies
        SET folder = 'warmup', category = 'warmup', classify_state = 'done',
            ai_model = 'pv-mailbox', ai_reasoning = 'sender is a PV warm-up mailbox',
            updated_at = NOW()
      WHERE lower(sender_email) = ANY($1) AND ${SAFE}
      RETURNING id`,
    [emailList]
  )
  return NextResponse.json({
    ok: true,
    mode: 'apply',
    mailboxes_in_set: emailList.length,
    replies_moved_to_warmup: moved.rowCount ?? 0,
  })
}
