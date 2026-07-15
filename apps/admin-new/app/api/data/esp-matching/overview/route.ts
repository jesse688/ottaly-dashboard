import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getPvJwt, hasPvCreds } from '@/lib/pv-auth'
import { normalizeMapping, snapshotAndDiff, type Mapping } from '@/lib/esp-audit'

export const dynamic = 'force-dynamic'

const PIPL = 'https://api.pipl.ai/v1'

// Live-fetch every workspace's current ESP mapping, snapshot it, and flag any
// that drifted since the last snapshot (changed outside this tool). ~38 sequential
// reads — bounded concurrency keeps it a few seconds. Uses the server login.
export async function GET() {
  if (!hasPvCreds()) {
    return NextResponse.json({ error: 'Server login not configured (PLUSVIBE_LOGIN_*)' }, { status: 400 })
  }
  try {
    const { rows: wss } = await pool.query<{ id: string; name: string }>(
      `SELECT workspace_id AS id, COALESCE(NULLIF(workspace_name,''), workspace_id) AS name
         FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id <> '' ORDER BY name`,
    )
    const token = await getPvJwt()
    const now = Date.now()

    async function fetchOne(ws: { id: string; name: string }) {
      try {
        const res = await fetch(`${PIPL}/user/get-workspace-setting?workspace_id=${ws.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return { ...ws, mapping: null, drifted: false, error: `HTTP ${res.status}` }
        const data = await res.json()
        const esp = data?.esp_setting ? data : data?.data?.esp_setting ? data.data : data?.data || data
        const mapping: Mapping = normalizeMapping(esp?.esp_setting)
        const { drifted } = await snapshotAndDiff(ws.id, ws.name, mapping, now)
        return { ...ws, mapping, drifted, error: null }
      } catch (e) {
        return { ...ws, mapping: null, drifted: false, error: e instanceof Error ? e.message : 'fetch failed' }
      }
    }

    // Concurrency cap 6 so we don't hammer pipl.ai / trip rate limits.
    const results: Array<Record<string, unknown>> = []
    const CONC = 6
    for (let i = 0; i < wss.length; i += CONC) {
      const batch = wss.slice(i, i + CONC)
      results.push(...(await Promise.all(batch.map(fetchOne))))
    }

    return NextResponse.json({ workspaces: results, fetched_at: now })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
