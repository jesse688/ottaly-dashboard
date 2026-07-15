import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// Enable (or disable) ESP matching on campaigns. Workspace-level ESP mappings do
// NOTHING unless is_esp_match=1 on each campaign (PlusVibe's own warning). This
// flips is_esp_match across campaigns so the mappings actually enforce.
//
// Uses the PUBLIC api.plusvibe.ai + stable x-api-key (campaign endpoints work
// there). The update endpoint requires first_wait_time even for a partial patch,
// so we read each campaign and echo its own first_wait_time back.
//
// POST body: { action:'enable'|'disable', workspace_ids?: string[] }  (omit → all)
// GET: per-workspace status — how many active campaigns have ESP match on/off.

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

interface Campaign {
  id: string
  camp_name?: string
  status?: string
  is_esp_match?: number
  first_wait_time?: number
  campaign_type?: string
}

async function listCampaigns(wsId: string): Promise<Campaign[]> {
  // Use /campaign/list-all: it returns the FULL campaign objects (including
  // is_esp_match + first_wait_time, which we need). /campaign/list returns only
  // minimal fields and 400s on limit>100.
  const res = await fetch(`${PV_BASE}/campaign/list-all?workspace_id=${wsId}`, {
    headers: { 'x-api-key': PV_KEY },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`campaign/list-all ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : data?.data ?? data?.campaigns ?? []
}

async function setEspMatch(wsId: string, c: Campaign, on: boolean): Promise<void> {
  // update endpoint requires first_wait_time; echo the campaign's own value.
  const body = {
    workspace_id: wsId,
    campaign_id: c.id,
    is_esp_match: on ? 'yes' : 'no',
    first_wait_time: typeof c.first_wait_time === 'number' ? c.first_wait_time : 0,
  }
  const res = await fetch(`${PV_BASE}/campaign/update/campaign`, {
    method: 'PATCH',
    headers: { 'x-api-key': PV_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`update ${res.status} ${t.slice(0, 120)}`)
  }
}

async function activeWorkspaces(ids?: string[]): Promise<Array<{ id: string; name: string }>> {
  if (ids && ids.length) {
    const { rows } = await pool.query(
      `SELECT workspace_id AS id, COALESCE(NULLIF(workspace_name,''),workspace_id) AS name
         FROM workspace_stats WHERE workspace_id = ANY($1)`,
      [ids],
    )
    return rows
  }
  const { rows } = await pool.query(
    `SELECT workspace_id AS id, COALESCE(NULLIF(workspace_name,''),workspace_id) AS name
       FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id <> '' ORDER BY name`,
  )
  return rows
}

export async function GET() {
  if (!PV_KEY) return NextResponse.json({ error: 'PLUSVIBE_KEY not set' }, { status: 400 })
  try {
    const wss = await activeWorkspaces()
    const CONC = 5
    const out: Array<Record<string, unknown>> = []
    for (let i = 0; i < wss.length; i += CONC) {
      const batch = wss.slice(i, i + CONC)
      const res = await Promise.all(
        batch.map(async (ws) => {
          try {
            const camps = (await listCampaigns(ws.id)).filter((c) => c.status === 'ACTIVE')
            const on = camps.filter((c) => c.is_esp_match === 1).length
            return { ...ws, active: camps.length, esp_on: on, esp_off: camps.length - on, error: null }
          } catch (e) {
            return { ...ws, active: 0, esp_on: 0, esp_off: 0, error: e instanceof Error ? e.message : 'err' }
          }
        }),
      )
      out.push(...res)
    }
    return NextResponse.json({ workspaces: out })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!PV_KEY) return NextResponse.json({ error: 'PLUSVIBE_KEY not set' }, { status: 400 })
  const body = await req.json().catch(() => ({}))
  const on = body?.action !== 'disable' // default enable
  const wsIds: string[] | undefined = Array.isArray(body?.workspace_ids) ? body.workspace_ids : undefined
  try {
    const wss = await activeWorkspaces(wsIds)
    let updated = 0
    let failed = 0
    const perWs: Array<Record<string, unknown>> = []
    for (const ws of wss) {
      try {
        const camps = (await listCampaigns(ws.id)).filter((c) => c.status === 'ACTIVE')
        let u = 0,
          f = 0
        for (const c of camps) {
          try {
            await setEspMatch(ws.id, c, on)
            u++
          } catch {
            f++
          }
        }
        updated += u
        failed += f
        perWs.push({ id: ws.id, name: ws.name, updated: u, failed: f, campaigns: camps.length })
      } catch (e) {
        perWs.push({ id: ws.id, name: ws.name, error: e instanceof Error ? e.message : 'err' })
      }
    }
    return NextResponse.json({ on, updated, failed, workspaces: perWs })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
