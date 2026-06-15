import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getBisonKey, getWorkspaces, switchWorkspace, withTeam } from '@/lib/bison'

const BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '')

// Admin diagnostic: for a given Bison team, show exactly what the key sees so we
// can tell WHY a backfill returns 0 leads. ?team=3 (Ottaly). Returns: workspaces
// the key can see, raw lead count for that team, interested count, and the keys
// of the first lead object (to confirm the 'interested' field exists / its name).
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const team = new URL(req.url).searchParams.get('team') || '3'

  const key = await getBisonKey()
  if (!key) return NextResponse.json({ error: 'No Bison key' }, { status: 400 })

  const out: Record<string, unknown> = { team }
  try {
    const ws = await getWorkspaces()
    out.workspacesKeyCanSee = Array.isArray(ws) ? ws.length : 0
    out.workspaceNames = (ws || []).map(w => `${w.id}:${w.name}`).slice(0, 30)
  } catch (e) { out.workspacesError = String(e) }

  try {
    await withTeam(team, async () => {
      const res = await fetch(`${BASE}/api/leads?page=1&per_page=100`, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      out.leadsHttpStatus = res.status
      const json = await res.json().catch(() => ({}))
      const data = Array.isArray(json) ? json : (json.data ?? [])
      out.rawLeadCount = Array.isArray(data) ? data.length : 0
      out.interestedCount = Array.isArray(data) ? data.filter((l: { interested?: boolean }) => l.interested === true).length : 0
      if (data[0]) {
        out.firstLeadKeys = Object.keys(data[0])
        out.firstLeadSample = {
          id: data[0].id, email: data[0].email,
          interested: data[0].interested, status: data[0].status,
          tags: data[0].tags ?? data[0].tag_ids ?? null,
        }
      }
      // Also probe whether a "lead" tag exists in this workspace.
      try {
        const tagsRes = await fetch(`${BASE}/api/tags`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) })
        const tagsJson = await tagsRes.json().catch(() => ({}))
        const tags = Array.isArray(tagsJson) ? tagsJson : (tagsJson.data ?? [])
        out.tagsInWorkspace = (tags || []).map((t: { id: number; name: string }) => `${t.id}:${t.name}`).slice(0, 30)
      } catch (e) { out.tagsError = String(e) }
    })
  } catch (e) { out.leadsError = String(e) }

  void switchWorkspace
  return NextResponse.json(out)
}
