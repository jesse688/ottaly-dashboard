import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getBisonKey, getWorkspaces } from '@/lib/bison'

// POST — test the currently-saved Bison key by listing workspaces it can see.
// A super-admin key sees many; a per-workspace key sees ~1 (and per-client lead
// loads would fail). We surface the count so admin can tell which they pasted.
export async function POST() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await getBisonKey()) return NextResponse.json({ ok: false, error: 'No Bison key configured' }, { status: 400 })
  try {
    const ws = await getWorkspaces()
    const count = Array.isArray(ws) ? ws.length : 0
    return NextResponse.json({
      ok: true,
      workspaces: count,
      superAdmin: count > 1,
      note: count > 1
        ? `Working — this key can see ${count} workspaces (super-admin ✓).`
        : `Key works but only sees ${count} workspace. Per-client leads need a SUPER-ADMIN key that can switch into every team.`,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
}
