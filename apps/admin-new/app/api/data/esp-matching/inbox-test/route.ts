import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { startTest, restoreTest, finalizeTest } from '@/lib/inbox-test'

export const dynamic = 'force-dynamic'

function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth
}

// GET  → list recent tests (status + results) for the dashboard.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, workspace_name, status, started_at, ends_at,
              window_hours, result, error, updated_at
         FROM esp_inbox_tests
        ORDER BY started_at DESC
        LIMIT 100`,
    )
    return NextResponse.json({ tests: rows })
  } catch (err) {
    // Table may not exist yet (no test ever run) — return empty rather than 500.
    return NextResponse.json({ tests: [], note: err instanceof Error ? err.message : 'no data' })
  }
}

// POST → start a test (or retest). Body:
//   { action: 'start', workspaces: [{id,name}], window_hours }
//   { action: 'retest_inconclusive', window_hours }   (re-runs only workspaces whose
//                                                       last test had any non-confident recipient)
//   { action: 'restore', id }                          (manual restore, needs token)
//   { action: 'finalize', id }                         (force-finalize now, for testing)
export async function POST(req: NextRequest) {
  const jwt = bearer(req)
  const body = await req.json().catch(() => ({}))
  const action = body?.action

  try {
    if (action === 'start') {
      if (!jwt) return NextResponse.json({ error: 'Missing Bearer token' }, { status: 400 })
      const windowHours = Number(body.window_hours) || 1
      const wss: Array<{ id: string; name: string }> = Array.isArray(body.workspaces) ? body.workspaces : []
      if (!wss.length) return NextResponse.json({ error: 'No workspaces' }, { status: 400 })
      const started: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const w of wss) {
        try {
          const { id } = await startTest(w.id, w.name, jwt, windowHours)
          started.push(id)
        } catch (e) {
          failed.push({ id: w.id, error: e instanceof Error ? e.message : 'start failed' })
        }
      }
      return NextResponse.json({ started, failed })
    }

    if (action === 'retest_inconclusive') {
      if (!jwt) return NextResponse.json({ error: 'Missing Bearer token' }, { status: 400 })
      const windowHours = Number(body.window_hours) || 2
      // Latest test per workspace; retest those with any non-confident recipient.
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (workspace_id) workspace_id, workspace_name, result, status
           FROM esp_inbox_tests
          ORDER BY workspace_id, started_at DESC`,
      )
      const toRetest = rows.filter((r) => {
        if (r.status === 'running') return false
        const recs = r.result?.recommendations ?? []
        return recs.some((x: { confident: boolean }) => !x.confident)
      })
      const started: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const r of toRetest) {
        try {
          const { id } = await startTest(r.workspace_id, r.workspace_name || r.workspace_id, jwt, windowHours)
          started.push(id)
        } catch (e) {
          failed.push({ id: r.workspace_id, error: e instanceof Error ? e.message : 'start failed' })
        }
      }
      return NextResponse.json({ started, failed, retested: toRetest.length })
    }

    if (action === 'restore') {
      if (!jwt) return NextResponse.json({ error: 'Missing Bearer token' }, { status: 400 })
      if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      await restoreTest(body.id, jwt)
      return NextResponse.json({ ok: true })
    }

    if (action === 'finalize') {
      if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      await finalizeTest(body.id)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
