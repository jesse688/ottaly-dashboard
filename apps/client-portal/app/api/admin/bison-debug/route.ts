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
      out.interestedBooleanCount = Array.isArray(data) ? data.filter((l: { interested?: boolean }) => l.interested === true).length : 0
      // Count leads carrying the Interested / Meeting Booked TAG (the real signal).
      const leadTagNames = new Set(['interested', 'meeting booked'])
      out.taggedLeadCount = Array.isArray(data)
        ? data.filter((l: { tags?: Array<{ name?: string }> }) =>
            (l.tags ?? []).some(t => leadTagNames.has((t.name ?? '').trim().toLowerCase()))).length
        : 0
      // Show every distinct tag NAME actually applied across the returned leads,
      // with how many leads have it — so we see what marker (if any) is in use.
      const tagFreq: Record<string, number> = {}
      for (const l of (Array.isArray(data) ? data : [])) {
        for (const t of ((l as { tags?: Array<{ name?: string }> }).tags ?? [])) {
          const n = (t.name ?? '').trim() || '(unnamed)'
          tagFreq[n] = (tagFreq[n] ?? 0) + 1
        }
      }
      out.tagsAppliedToLeads = tagFreq
      // Show status values in use too (in case lead-marking is via status).
      const statusFreq: Record<string, number> = {}
      for (const l of (Array.isArray(data) ? data : [])) {
        const s = String((l as { status?: string }).status ?? '(none)')
        statusFreq[s] = (statusFreq[s] ?? 0) + 1
      }
      out.statusesInUse = statusFreq
      if (data[0]) {
        out.firstLeadKeys = Object.keys(data[0])
        out.firstLeadSample = {
          id: data[0].id, email: data[0].email,
          status: data[0].status,
          tags: (data[0].tags ?? []).map((t: { name?: string }) => t.name),
        }
      }
      // Also probe whether a "lead" tag exists in this workspace.
      try {
        const tagsRes = await fetch(`${BASE}/api/tags`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) })
        const tagsJson = await tagsRes.json().catch(() => ({}))
        const tags = Array.isArray(tagsJson) ? tagsJson : (tagsJson.data ?? [])
        out.tagsInWorkspace = (tags || []).map((t: { id: number; name: string }) => `${t.id}:${t.name}`).slice(0, 30)
      } catch (e) { out.tagsError = String(e) }
      // Show the webhook URL(s) Bison ACTUALLY has registered for this workspace
      // + which events — so we can confirm replies are pointed at the right place.
      try {
        const whRes = await fetch(`${BASE}/api/webhook-url`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) })
        const whJson = await whRes.json().catch(() => ({}))
        const hooks = Array.isArray(whJson) ? whJson : (whJson.data ?? [])
        out.registeredWebhooks = (hooks || []).map((h: { url?: string; events?: string[] }) => ({ url: h.url, events: h.events }))
      } catch (e) { out.webhookError = String(e) }
    })
    out.portalExpectsWebhookUrl = process.env.BISON_WEBHOOK_TARGET_URL || 'https://login.ottaly.co.uk/api/webhooks/plusvibe'
  } catch (e) { out.leadsError = String(e) }

  void switchWorkspace
  return NextResponse.json(out)
}
