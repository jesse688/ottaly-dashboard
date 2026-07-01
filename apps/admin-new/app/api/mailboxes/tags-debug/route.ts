import { NextResponse } from 'next/server'

// ── PlusVibe tag diagnostic ──────────────────────────────────────────────────
// One-click (no params) probe to discover WHERE PlusVibe exposes account tags.
// Open /api/mailboxes/tags-debug in the browser (logged in) and read the JSON:
//   - accountKeys : every field name on a PV account object
//   - tagLike     : any field whose name matches tag/label, or any array field
//                   (candidate tag lists) with a few sample values
//   - sampleAccount: one raw account (truncated) to eyeball
//   - tagsResource: whether a separate /tag(s) endpoint returns data
// This tells us exactly how to read tags so the tag→supplier grouping can fire.

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? process.env.PLUSVIBE_API_KEY ?? ''

async function pv(path: string): Promise<unknown> {
  const res = await fetch(`${PV_BASE}${path}`, {
    headers: { 'x-api-key': PV_KEY },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[]
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['accounts', 'email_accounts', 'data', 'workspaces']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[]
    }
  }
  return []
}

export async function GET() {
  if (!PV_KEY) return NextResponse.json({ error: 'PLUSVIBE_KEY not set on this deploy' }, { status: 500 })
  const out: Record<string, unknown> = {}
  try {
    // 1. Workspaces (so we never need a hand-typed id).
    const wsRaw = await pv('/workspaces')
    const workspaces = asArray(wsRaw)
      .map(w => ({ id: (w.id ?? w._id) as string | undefined, name: w.name as string | undefined }))
      .filter(w => !!w.id)
    out.workspaceCount = workspaces.length
    out.workspacesSample = workspaces.slice(0, 5)

    // 2. Scan accounts from the first few workspaces for tag-like fields.
    const accountKeys = new Set<string>()
    const tagLike: Record<string, unknown> = {}
    let sampleAccount: Record<string, unknown> | null = null
    let scanned = 0
    for (const w of workspaces.slice(0, 4)) {
      let list: Record<string, unknown>[] = []
      try { list = asArray(await pv(`/account/list?workspace_id=${encodeURIComponent(w.id!)}&skip=0&limit=100`)) }
      catch (e) { out[`ws_${w.id}_error`] = e instanceof Error ? e.message : String(e); continue }
      for (const a of list) {
        scanned++
        for (const k of Object.keys(a)) accountKeys.add(k)
        for (const [k, v] of Object.entries(a)) {
          if (v == null) continue
          if (/tag|label/i.test(k)) tagLike[k] = v
          // Any array field that isn't the known campaigns list is a tag candidate.
          if (Array.isArray(v) && v.length && !/cmps|campaign/i.test(k)) {
            tagLike[`array:${k}`] = (v as unknown[]).slice(0, 5)
          }
        }
        if (!sampleAccount) {
          // Truncate the payload so the dump stays readable.
          const { payload, ...rest } = a as Record<string, unknown>
          sampleAccount = { ...rest, payload: payload && typeof payload === 'object' ? Object.keys(payload as object) : payload }
        }
      }
      if (Object.keys(tagLike).length) break
    }
    out.accountsScanned = scanned
    out.accountKeys = [...accountKeys].sort()
    out.tagLike = tagLike
    out.sampleAccount = sampleAccount

    // 3. Is there a separate PV tags resource? (assign uses bulk_assign_tags, so
    //    tags may live outside the account object.)
    const wsId = workspaces[0]?.id ?? ''
    for (const p of [`/tag/list?workspace_id=${wsId}`, `/tags?workspace_id=${wsId}`, `/account/tags?workspace_id=${wsId}`]) {
      try { out.tagsResource = { endpoint: p.split('?')[0], data: await pv(p) }; break }
      catch (e) { out[`tagsEndpoint_${p.split('?')[0]}`] = e instanceof Error ? e.message : String(e) }
    }

    return NextResponse.json(out)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed', partial: out }, { status: 502 })
  }
}
