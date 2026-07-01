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

    // 2. Scan accounts across workspaces, digging into payload.tags specifically
    //    (that's where PV keeps them). Collect the raw value SHAPE + distinct tag
    //    strings, and a few emails per tag so we can see the "google generic" set.
    const rawTagSamples: unknown[] = []              // first few raw payload.tags arrays, verbatim
    const distinctTags = new Map<string, number>()   // normalized-name → count
    const emailsByTag = new Map<string, string[]>()  // tag → sample emails
    let scanned = 0, withTags = 0
    for (const w of workspaces.slice(0, 20)) {        // cap for time; enough to find the batch
      let list: Record<string, unknown>[] = []
      try { list = asArray(await pv(`/account/list?workspace_id=${encodeURIComponent(w.id!)}&skip=0&limit=200`)) }
      catch (e) { out[`ws_${w.name}_error`] = e instanceof Error ? e.message : String(e); continue }
      for (const a of list) {
        scanned++
        const email = String(a.email ?? '')
        const payload = (a.payload as Record<string, unknown> | null) || {}
        const t = payload.tags
        if (!Array.isArray(t) || !t.length) continue
        withTags++
        if (rawTagSamples.length < 6) rawTagSamples.push({ email, tags: t })
        for (const x of t as unknown[]) {
          let name: string | null = null
          if (typeof x === 'string') name = x
          else if (x && typeof x === 'object') {
            const o = x as Record<string, unknown>
            const n = o.name ?? o.tag ?? o.label ?? o.title ?? o.value
            if (n != null) name = String(n)
          }
          if (!name) continue
          distinctTags.set(name, (distinctTags.get(name) ?? 0) + 1)
          const arr = emailsByTag.get(name) ?? []
          if (arr.length < 3) { arr.push(email); emailsByTag.set(name, arr) }
        }
      }
      // Stop early once we've clearly found the google-generic batch.
      if ([...distinctTags.keys()].some(k => /generic/i.test(k))) break
    }
    out.accountsScanned = scanned
    out.accountsWithTags = withTags
    out.rawTagSamples = rawTagSamples
    out.distinctTags = Object.fromEntries([...distinctTags.entries()].slice(0, 60))
    out.genericTagEmails = Object.fromEntries(
      [...emailsByTag.entries()].filter(([k]) => /generic/i.test(k))
    )

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
