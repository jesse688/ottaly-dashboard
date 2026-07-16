import { type NextRequest, NextResponse } from 'next/server'
import { readSplit, recomputeWorkspace, recomputeAll, STANDARD_WINDOWS } from '@/lib/newlead-cache'

export const dynamic = 'force-dynamic'

// New-lead (step-1) vs follow-up split per combo. PlusVibe's new-lead count is
// only meaningful over a multi-day window and its API is slow, so:
//  - GET  reads the PRECOMPUTED cache (instant). Agency-wide when no workspace_id.
//         window snaps to a standard precomputed window (7 or 30 days).
//  - POST {action:'refresh', window_days?, workspace_id?} recomputes on demand
//         (one workspace ~1 min; agency ~11 min, kicked off in background).

function daysFromRange(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z').getTime()
  const e = new Date(end + 'T00:00:00Z').getTime()
  return Math.max(1, Math.round((e - s) / 86400000) + 1)
}
function snapWindow(days: number): number {
  return STANDARD_WINDOWS.reduce(
    (a, b) => (Math.abs(b - days) < Math.abs(a - days) ? b : a),
    STANDARD_WINDOWS[0],
  )
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const workspaceId = sp.get('workspace_id') || undefined
  let windowDays = Number(sp.get('window_days')) || 0
  if (!windowDays) {
    const start = sp.get('start') || ''
    const end = sp.get('end') || ''
    if (start && end) windowDays = daysFromRange(start, end)
  }
  const win = snapWindow(windowDays || 7)
  try {
    const { combos, computed_at } = await readSplit(win, workspaceId)
    return NextResponse.json({ combos, computed_at, window_days: win, standard_windows: STANDARD_WINDOWS })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const workspaceId: string | undefined = body?.workspace_id || undefined
  const windowDays = Number(body?.window_days) || undefined
  const windows = windowDays ? [snapWindow(windowDays)] : STANDARD_WINDOWS
  try {
    if (workspaceId) {
      await recomputeWorkspace(workspaceId, windows)
      const { combos, computed_at } = await readSplit(windows[0], workspaceId)
      return NextResponse.json({ ok: true, combos, computed_at, window_days: windows[0] })
    }
    // Agency refresh is heavy (~11 min) — kick it off but don't block the request.
    recomputeAll(windows).catch(() => {})
    return NextResponse.json({ ok: true, started: true, note: 'Agency refresh started (~11 min). Reload later.' })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
