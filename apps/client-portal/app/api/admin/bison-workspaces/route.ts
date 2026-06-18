import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBisonKey, getWorkspaces, PV_TO_BISON_TEAM } from '@/lib/bison'

// Admin tool: list EVERY Bison workspace (team_id → name) the super-admin key can
// see, cross-referenced against PV_TO_BISON_TEAM and portal_clients — so we can
// fill in unmapped clients and spot stale/wrong map entries in one view.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await getBisonKey()) return NextResponse.json({ error: 'No Bison key configured' }, { status: 400 })

  // Bison teams the key can see.
  let bisonTeams: { id: string; name: string }[] = []
  try {
    const ws = await getWorkspaces()
    bisonTeams = (ws || []).map(w => ({ id: String(w.id), name: w.name }))
  } catch (err) {
    return NextResponse.json({ error: `Bison list failed: ${(err as Error).message}` }, { status: 502 })
  }

  // Reverse map: team_id → PV workspace_id (from the code map).
  const teamToPv: Record<string, string> = {}
  for (const [pv, team] of Object.entries(PV_TO_BISON_TEAM)) teamToPv[team] = pv

  // Portal clients keyed by PV workspace_id.
  const clientsRes = await pool.query(
    `SELECT workspace_id, company_name FROM portal_clients WHERE workspace_id IS NOT NULL AND workspace_id <> ''`
  )
  const clientByPv: Record<string, string> = {}
  for (const r of clientsRes.rows) clientByPv[r.workspace_id] = r.company_name

  // For each Bison team: is it in the map? does that PV id have a client?
  const teams = bisonTeams.map(t => {
    const mappedPv = teamToPv[t.id] ?? null
    const client = mappedPv ? (clientByPv[mappedPv] ?? null) : null
    return {
      bisonTeamId: t.id,
      bisonName: t.name,
      mappedPvWorkspaceId: mappedPv,
      mappedClient: client,
      status: !mappedPv ? 'UNMAPPED (add to PV_TO_BISON_TEAM)'
            : !client ? 'mapped but PV id has no portal client (check)'
            : 'ok',
    }
  })

  // Portal clients that have NO Bison team in the map at all.
  const mappedPvIds = new Set(Object.keys(PV_TO_BISON_TEAM))
  const clientsWithoutTeam = clientsRes.rows
    .filter(r => !mappedPvIds.has(r.workspace_id))
    .map(r => ({ company: r.company_name, pvWorkspaceId: r.workspace_id }))

  return NextResponse.json({
    bisonTeamsKeyCanSee: bisonTeams.length,
    note: bisonTeams.length <= 1
      ? 'Key only sees its own team — set a SUPER-ADMIN key in Settings to list all.'
      : 'OK',
    teams,
    clientsWithoutTeamMapping: clientsWithoutTeam,
  })
}
