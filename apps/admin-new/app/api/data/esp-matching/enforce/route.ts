import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getPvJwt, invalidatePvJwt, hasPvCreds } from '@/lib/pv-auth'
import { normalizeMapping, logEspChange, type Mapping } from '@/lib/esp-audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── DAILY "Other → Other" ENFORCER ───────────────────────────────────────────
// Hard rule: an "Other ESP" sender (REGULAR_ACCOUNT) must NEVER send to an "Other"
// recipient (REGULAR_ACCOUNT) — our worst-delivering combo. The /esp-matching page
// blocks it in the UI, but that only helps when someone uses the page. Workspaces
// can be edited directly in PlusVibe, and mappings drift. This endpoint sweeps
// EVERY workspace daily: reads its live ESP mapping and, if the Other recipient's
// allowed senders include REGULAR_ACCOUNT, rewrites the mapping with that entry
// stripped (leaving Google/Microsoft senders and all other rows untouched).
//
// Auth: this route is in middleware's PUBLIC_PATHS, so it protects itself with a
// shared secret — pass ?key=<ADMIN_KEY>. Wire it to a daily cron (cron-job.org).
//   GET /api/data/esp-matching/enforce?key=<ADMIN_KEY>[&dry=1]
// ?dry=1 reports what WOULD change without writing.

const PIPL = 'https://api.pipl.ai/v1'
const OTHER = 'REGULAR_ACCOUNT'

interface EspEntry { recipient_esp: string; sender_esp?: string[]; tag_ids?: string }

// Does the Other-recipient row currently allow an Other sender?
function hasOtherToOther(espSetting: EspEntry[]): boolean {
  const other = espSetting.find((e) => e.recipient_esp === OTHER)
  return !!other?.sender_esp?.includes(OTHER)
}

// Return a NEW esp_setting with REGULAR_ACCOUNT stripped from the Other row's
// senders. Everything else (other rows, tag_ids) is preserved verbatim so we only
// remove the banned combo and never disturb a valid mapping.
function stripOtherToOther(espSetting: EspEntry[]): EspEntry[] {
  return espSetting.map((e) =>
    e.recipient_esp === OTHER
      ? { ...e, sender_esp: (e.sender_esp ?? []).filter((s) => s !== OTHER) }
      : e,
  )
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || ''
  const expected = process.env.ADMIN_KEY || ''
  if (!expected || key !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPvCreds()) {
    return NextResponse.json({ error: 'Server login not configured (PLUSVIBE_LOGIN_*)' }, { status: 400 })
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'

  try {
    const { rows: wss } = await pool.query<{ id: string; name: string }>(
      `SELECT workspace_id AS id, COALESCE(NULLIF(workspace_name,''), workspace_id) AS name
         FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id <> '' ORDER BY name`,
    )
    let token = await getPvJwt()
    const now = Date.now()

    // Read one workspace's mapping; refresh the token once on 401. Returns the
    // HTTP status alongside the data so callers can report WHY a read failed
    // (e.g. 404 = workspace not on this account → no ESP setting to enforce).
    async function readSetting(wsId: string): Promise<{ full: Record<string, unknown>; esp: EspEntry[]; status: number }> {
      const doFetch = () =>
        fetch(`${PIPL}/user/get-workspace-setting?workspace_id=${encodeURIComponent(wsId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        })
      let res = await doFetch()
      if (res.status === 401) {
        invalidatePvJwt()
        token = await getPvJwt()
        res = await doFetch()
      }
      if (!res.ok) return { full: {}, esp: [], status: res.status }
      const data = await res.json()
      const espObj = data?.esp_setting ? data : data?.data?.esp_setting ? data.data : data?.data || data
      return { full: espObj as Record<string, unknown>, esp: (espObj?.esp_setting as EspEntry[]) || [], status: res.status }
    }

    // Write a corrected mapping back, echoing the workspace's own cap fields so we
    // don't accidentally reset them.
    async function writeSetting(wsId: string, full: Record<string, unknown>, esp: EspEntry[]): Promise<boolean> {
      const payload: Record<string, unknown> = { esp_setting: esp }
      // Preserve the daily-cap fields PlusVibe expects (mirrors the manual writer).
      const cap = Number(full.max_lead_domain_per_day) || 0
      payload.is_max_lead_domain_per_day = cap >= 1 ? 1 : 0
      if (cap >= 1) payload.max_lead_domain_per_day = cap
      const doFetch = () =>
        fetch(`${PIPL}/user/update-workspace-setting?workspace_id=${encodeURIComponent(wsId)}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        })
      let res = await doFetch()
      if (res.status === 401) {
        invalidatePvJwt()
        token = await getPvJwt()
        res = await doFetch()
      }
      return res.ok
    }

    async function enforceOne(ws: { id: string; name: string }) {
      try {
        const read = await readSetting(ws.id)
        if (read.status !== 200) {
          return { ...ws, checked: false, violation: false, fixed: false, error: `read failed (HTTP ${read.status})` }
        }
        if (!hasOtherToOther(read.esp)) {
          return { ...ws, checked: true, violation: false, fixed: false, error: null }
        }
        // Violation found.
        if (dryRun) return { ...ws, checked: true, violation: true, fixed: false, error: null }
        const before: Mapping = normalizeMapping(read.esp)
        const fixedEsp = stripOtherToOther(read.esp)
        const ok = await writeSetting(ws.id, read.full, fixedEsp)
        if (ok) {
          await logEspChange(ws.id, ws.name, before, normalizeMapping(fixedEsp), 'daily-enforce', now,
            'auto-removed Other→Other')
        }
        return { ...ws, checked: true, violation: true, fixed: ok, error: ok ? null : 'write failed' }
      } catch (e) {
        return { ...ws, checked: false, violation: false, fixed: false, error: e instanceof Error ? e.message : 'error' }
      }
    }

    // Concurrency cap 6 (matches the overview sweep) to avoid tripping pipl.ai limits.
    const results: Array<Record<string, unknown>> = []
    const CONC = 6
    for (let i = 0; i < wss.length; i += CONC) {
      const batch = wss.slice(i, i + CONC)
      results.push(...(await Promise.all(batch.map(enforceOne))))
    }

    const violations = results.filter((r) => r.violation)
    const fixed = results.filter((r) => r.fixed)
    const errors = results.filter((r) => r.error)
    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      checked_at: now,
      total: results.length,
      violations: violations.length,
      fixed: fixed.length,
      errors: errors.length,
      offenders: violations.map((r) => ({ id: r.id, name: r.name, fixed: r.fixed, error: r.error })),
      error_workspaces: errors.map((r) => ({ id: r.id, name: r.name, error: r.error })),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
