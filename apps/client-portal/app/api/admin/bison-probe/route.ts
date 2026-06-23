import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { bisonApi, withTeam, type BisonReply } from '@/lib/bison'
import { detectWarmupFull } from '@/lib/classify'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// GET /api/admin/bison-probe?team=5&q=scalford&maxPages=800&ws=<workspaceId>
// Diagnostic: pages Bison's inbox replies for one team and reports exactly how a
// search term shows up — which page it's on, its tracked_reply / folder / type /
// interested flags, and whether our warmup filter would drop it. This is how we
// find out WHY a reply (e.g. Scalford) never got ingested. Read-only.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const secretOk = !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!secretOk && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const team = url.searchParams.get('team')
  const q = (url.searchParams.get('q') || '').toLowerCase()
  const ws = url.searchParams.get('ws') || ''
  const maxPages = Math.min(Math.max(parseInt(url.searchParams.get('maxPages') || '800', 10) || 800, 1), 2000)
  if (!team) return NextResponse.json({ error: 'pass ?team=<bisonTeamId>' }, { status: 400 })
  if (!q) return NextResponse.json({ error: 'pass ?q=<search>' }, { status: 400 })

  const fetchPage = (p: number) =>
    bisonApi<{ data?: BisonReply[]; meta?: { last_page?: number } }>('GET', '/api/replies', { folder: 'inbox', page: p })
      .then(d => ({ batch: (Array.isArray(d) ? (d as unknown as BisonReply[]) : d.data ?? []), lastPage: (d as { meta?: { last_page?: number } }).meta?.last_page ?? 1 }))
      .catch(() => ({ batch: [] as BisonReply[], lastPage: 1 }))

  type Match = {
    page: number; id: number | string | undefined; from: string | null | undefined
    subject: string | null | undefined; tracked_reply: boolean | undefined; type: string | undefined
    folder: string; interested: boolean; automated_reply: boolean; date_received: string | null | undefined
    warmup_tag: boolean
  }

  const result = await withTeam(team, async () => {
    const matches: Match[] = []
    let scanned = 0, untracked = 0, lastPage = 1
    const hit = (r: BisonReply) =>
      (r.from_email_address ?? '').toLowerCase().includes(q) || (r.subject ?? '').toLowerCase().includes(q)

    for (let start = 1; start <= maxPages; start += 8) {
      const pages: number[] = []
      for (let p = start; p < start + 8 && p <= maxPages; p++) pages.push(p)
      const blocks = await Promise.all(pages.map(p => fetchPage(p).then(r => ({ p, ...r }))))
      let empty = false
      for (const { p, batch, lastPage: lp } of blocks) {
        lastPage = Math.max(lastPage, lp)
        if (!batch.length) { empty = true; continue }
        scanned += batch.length
        for (const r of batch) {
          if (r.tracked_reply === false) untracked++
          if (hit(r)) {
            const warm = await detectWarmupFull(ws, { subject: r.subject ?? '', bodyText: r.text_body ?? '', rawText: r.html_body ?? '' })
            matches.push({
              page: p, id: r.id, from: r.from_email_address, subject: r.subject,
              tracked_reply: r.tracked_reply, type: r.type, folder: r.folder,
              interested: r.interested, automated_reply: r.automated_reply,
              date_received: r.date_received, warmup_tag: warm.isWarmup,
            })
          }
        }
      }
      if (empty || start >= lastPage) break
    }
    return { scanned, untracked, lastPage, matchCount: matches.length, matches }
  })

  return NextResponse.json({ team, q, maxPages, ...result })
}
