import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { bisonTeamForWorkspace, getCampaigns } from '@/lib/bison'

// Associate an unmapped / forwarded reply (one that arrived with no campaign — a
// forward, or a reply from an address we can't auto-match) with the right Bison
// campaign. We already know the CLIENT from the address it was sent to, so this
// only needs the campaign.
//
// GET  → list the client's Bison campaigns + an auto-suggested best match.
// POST → persist the chosen campaign onto the reply (and the lead row).

interface Row {
  id: string
  bison_team_id: string | null
  workspace_id: string | null
  campaign_id: string | null
  lead_email: string | null
}

async function loadReply(id: string): Promise<Row | null> {
  const r = await pool.query(
    `SELECT id, bison_team_id, workspace_id, campaign_id, lead_email FROM unibox_replies WHERE id = $1`,
    [id]
  )
  return (r.rows[0] as Row) ?? null
}

// Resolve the Bison team for listing campaigns. The unibox row ALWAYS stores
// bison_team_id (the team that delivered the reply) — use it directly, since
// it's present even for "unmapped" replies (workspace_id null). Fall back to the
// workspace→team map only if bison_team_id is somehow missing.
function teamFor(reply: Row): string | null {
  if (reply.bison_team_id) return String(reply.bison_team_id)
  if (reply.workspace_id) return bisonTeamForWorkspace(reply.workspace_id)
  return null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params

  const reply = await loadReply(id)
  if (!reply) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })

  const teamId = teamFor(reply)
  if (!teamId) {
    return NextResponse.json({ error: 'Reply has no Bison team — cannot list campaigns', campaigns: [] }, { status: 409 })
  }

  let campaigns: { id: number; name: string; status?: string | null }[] = []
  try {
    campaigns = await getCampaigns(teamId)
  } catch (err) {
    return NextResponse.json({ error: `Could not load campaigns: ${String(err).slice(0, 200)}`, campaigns: [] }, { status: 502 })
  }

  // Auto-suggest: (1) a campaign already stamped on the reply or its lead row,
  // (2) else the campaign whose name best matches the lead's company/domain.
  let suggestedId: number | null = null
  let suggestedReason = ''

  const known = reply.campaign_id
    ?? (reply.workspace_id
        ? (await pool.query(
            `SELECT campaign_id FROM esp_leads
              WHERE workspace_id = $1 AND lower(email) = lower($2) AND campaign_id IS NOT NULL
              ORDER BY (source = 'bison') DESC, updated_at DESC LIMIT 1`,
            [reply.workspace_id, reply.lead_email ?? '']
          )).rows[0]?.campaign_id as string | undefined
        : undefined)

  if (known) {
    const hit = campaigns.find(c => String(c.id) === String(known))
    if (hit) { suggestedId = hit.id; suggestedReason = 'matched the campaign already on this lead' }
  }

  // Fallback: fuzzy-match the lead's email domain against campaign names.
  if (!suggestedId && reply.lead_email) {
    const domain = (reply.lead_email.split('@')[1] ?? '').split('.')[0]?.toLowerCase()
    if (domain && domain.length >= 3) {
      const hit = campaigns.find(c => c.name.toLowerCase().includes(domain))
      if (hit) { suggestedId = hit.id; suggestedReason = `campaign name matches the lead's domain "${domain}"` }
    }
  }

  // Last resort: if there's exactly one campaign, suggest it.
  if (!suggestedId && campaigns.length === 1) {
    suggestedId = campaigns[0].id
    suggestedReason = 'the only campaign in this workspace'
  }

  return NextResponse.json({
    ok: true,
    campaigns,
    suggestedId,
    suggestedReason,
    currentId: reply.campaign_id ? Number(reply.campaign_id) : null,
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params

  const body = await req.json().catch(() => ({})) as { campaignId?: number | string }
  const campaignId = body.campaignId != null ? String(body.campaignId).trim() : ''
  if (!campaignId) return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })

  const reply = await loadReply(id)
  if (!reply) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })

  // Stamp the campaign onto the reply, and onto the lead row so the portal +
  // mark-as-lead show it. Idempotent.
  await pool.query(
    `UPDATE unibox_replies SET campaign_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, campaignId]
  )
  if (reply.workspace_id && reply.lead_email) {
    await pool.query(
      `UPDATE esp_leads SET campaign_id = $3, updated_at = NOW()
        WHERE workspace_id = $1 AND lower(email) = lower($2)`,
      [reply.workspace_id, reply.lead_email, campaignId]
    )
  }

  return NextResponse.json({ ok: true, campaignId })
}
