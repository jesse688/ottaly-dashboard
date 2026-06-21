import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getWorkspaces, withTeam, bisonApi } from '@/lib/bison'

// One-off: ensure every mailbox that carries a numbered "Winnr Generic N" tag
// ALSO carries the base "Winnr Generic" tag — so that deleting the numbered tags
// (1-5) later never orphans a mailbox out of the Winnr Generic set.
//
// Per workspace (Bison is stateful → withTeam):
//   1. list tags; find base (/^winnr generic$/i) + numbered (/^winnr generic [1-5]$/i)
//   2. skip workspace if it has no numbered Winnr Generic tags
//   3. list sender emails (with their tags)
//   4. any mailbox with a numbered tag but NOT the base → needs the base tag
//   5. (apply) create the base tag if missing, then attach it to those mailboxes
//
// GET  ?secret=CRON_SECRET → dry-run (reports the plan, NO writes)
// POST ?secret=CRON_SECRET → apply
interface Tag { id: number; name: string }
interface SenderEmail { id: number; email: string; tags?: Tag[] }

const isBase = (n: string) => /^\s*winnr generic\s*$/i.test(n)
const isNumbered = (n: string) => /^\s*winnr generic\s*[1-5]\s*$/i.test(n)

// Bison ignores per_page (~15/page) → page until the id-signature repeats.
async function listAllSenderEmails(): Promise<SenderEmail[]> {
  const out: SenderEmail[] = []
  let lastSig = ''
  for (let p = 1; p <= 400; p++) {
    const d = await bisonApi<{ data?: SenderEmail[] }>('GET', '/api/sender-emails', { page: p })
    const batch = d.data ?? []
    if (!batch.length) break
    const sig = batch.map(b => b.id).join(',')
    if (sig === lastSig) break
    lastSig = sig
    out.push(...batch)
  }
  return out
}

export async function GET(req: NextRequest) { return handle(req, false) }
export async function POST(req: NextRequest) { return handle(req, true) }

async function handle(req: NextRequest, apply: boolean) {
  const secret = new URL(req.url).searchParams.get('secret')
  const authed = (secret && secret === process.env.CRON_SECRET) || (await getAdminSession())
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let teams
  try {
    teams = await getWorkspaces()
  } catch (err) {
    return NextResponse.json({ error: `listing workspaces: ${String(err)}` }, { status: 502 })
  }

  const perWorkspace: Array<Record<string, unknown>> = []
  let totalToTag = 0
  let totalTagged = 0
  const errors: string[] = []

  for (const team of teams) {
    try {
      const result = await withTeam(team.id, async () => {
        const tagsResp = await bisonApi<{ data?: Tag[] }>('GET', '/api/tags')
        const tags = tagsResp.data ?? []
        const numbered = tags.filter(t => isNumbered(t.name))
        if (numbered.length === 0) return null // nothing to fix here

        const baseTags = tags.filter(t => isBase(t.name))
        const numberedIds = new Set(numbered.map(t => t.id))

        const mailboxes = await listAllSenderEmails()
        const needsBase = mailboxes.filter(m => {
          const mTags = m.tags ?? []
          const hasNumbered = mTags.some(t => numberedIds.has(t.id))
          const hasBase = mTags.some(t => isBase(t.name))
          return hasNumbered && !hasBase
        })

        const info: Record<string, unknown> = {
          workspace: team.name,
          numbered_tags: numbered.map(t => t.name),
          base_tags_found: baseTags.map(t => t.name),
          mailboxes_needing_base: needsBase.length,
          sample_emails: needsBase.slice(0, 5).map(m => m.email),
        }

        if (needsBase.length === 0) return info

        // Resolve the base tag id (create if missing). Ambiguous (>1) → skip + flag.
        let baseId: number | null = null
        if (baseTags.length === 1) baseId = baseTags[0].id
        else if (baseTags.length > 1) { info.skipped = 'multiple base tags — needs manual pick'; return info }

        if (apply) {
          if (baseId === null) {
            const created = await bisonApi<{ data?: Tag }>('POST', '/api/tags', undefined, { name: 'Winnr Generic' })
            baseId = created.data?.id ?? null
            info.created_base_tag = baseId !== null
          }
          if (baseId !== null) {
            await bisonApi('POST', '/api/tags/attach-to-sender-emails', undefined, {
              tag_ids: [baseId],
              sender_email_ids: needsBase.map(m => m.id),
            })
            info.tagged = needsBase.length
          }
        } else {
          info.would_create_base_tag = baseId === null
        }
        return info
      })

      if (result) {
        perWorkspace.push(result)
        totalToTag += (result.mailboxes_needing_base as number) ?? 0
        totalTagged += (result.tagged as number) ?? 0
      }
    } catch (err) {
      errors.push(`${team.name}: ${String(err).slice(0, 100)}`)
    }
  }

  return NextResponse.json({
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    workspaces_with_numbered_tags: perWorkspace.length,
    total_mailboxes_needing_base: totalToTag,
    total_tagged: totalTagged,
    per_workspace: perWorkspace,
    errors,
  })
}
