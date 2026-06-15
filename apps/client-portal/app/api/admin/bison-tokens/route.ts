import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import {
  PV_TO_BISON_TEAM, getBisonWsTokens, getBisonKey,
  mintBisonWsToken, saveBisonWsTokens,
} from '@/lib/bison'

// Manage the portal's per-workspace (user) Bison tokens. Using these instead of
// the super-admin key means the portal never calls switch-workspace — so it
// can't kick Jesse out of the Bison UI or collide with admin-legacy.

// GET — which teams have a token vs not (masked; never returns the token).
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const tokens = await getBisonWsTokens()
  const teams = Object.entries(PV_TO_BISON_TEAM).map(([pvId, teamId]) => ({
    pvWorkspaceId: pvId,
    teamId,
    hasToken: !!tokens[teamId],
    masked: tokens[teamId] ? '••••' + String(tokens[teamId]).slice(-4) : null,
  }))
  return NextResponse.json({
    total: teams.length,
    minted: teams.filter(t => t.hasToken).length,
    teams,
  })
}

// POST { teamId? } — mint a per-workspace token. With teamId, just that team;
// without, mint for EVERY mapped team that doesn't already have one.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await getBisonKey()) return NextResponse.json({ error: 'No super-admin Bison key set — needed to mint tokens' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as { teamId?: string | number; force?: boolean }
  const tokens = await getBisonWsTokens()
  const allTeamIds = Array.from(new Set(Object.values(PV_TO_BISON_TEAM)))
  const targets = body.teamId != null ? [String(body.teamId)] : allTeamIds

  const result = { minted: 0, skipped: 0, failed: [] as string[] }
  for (const teamId of targets) {
    if (tokens[teamId] && !body.force) { result.skipped++; continue }
    const tok = await mintBisonWsToken(teamId, `ottaly-portal-team-${teamId}`)
    if (tok) { tokens[teamId] = tok; result.minted++ }
    else result.failed.push(teamId)
  }
  await saveBisonWsTokens(tokens)
  return NextResponse.json({ ok: true, ...result, totalNow: Object.keys(tokens).length })
}

// DELETE { teamId } — remove one token (falls back to super-admin switch for it).
export async function DELETE(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { teamId?: string | number }
  const tokens = await getBisonWsTokens()
  if (body.teamId != null) delete tokens[String(body.teamId)]
  else for (const k of Object.keys(tokens)) delete tokens[k]
  await saveBisonWsTokens(tokens)
  return NextResponse.json({ ok: true, remaining: Object.keys(tokens).length })
}
