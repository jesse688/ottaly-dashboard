import pool from './db'
import { getActiveWorkspaceIds } from './active-clients'

// ── New-lead (step-1) vs follow-up cache ─────────────────────────────────────
// PlusVibe's total_new_lead_contacted_count is only meaningful over a multi-day
// window (0 per-day) and its stats API is slow (~8s/call → ~11 min for all
// workspaces × 9 combos). So we PRECOMPUTE the split nightly per workspace for
// standard windows into combo_newlead_cache; the agency view reads it instantly.
// An on-demand refresh reruns it for a chosen window.

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

const SENDER_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'google',
  MICROSOFT365: 'microsoft',
  REGULAR_ACCOUNT: 'smtp',
}
const RECIP_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'email_google',
  MICROSOFT365: 'email_outlook',
  REGULAR_ACCOUNT: 'email_other',
}
const ESP_CODES = ['GOOGLE_WORKSPACE', 'MICROSOFT365', 'REGULAR_ACCOUNT'] as const

// Standard windows precomputed by the nightly job.
export const STANDARD_WINDOWS = [7, 30] as const

let ready = false
async function ensureTable(): Promise<void> {
  if (ready) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS combo_newlead_cache (
       ws_id        TEXT NOT NULL,
       window_days  INT  NOT NULL,
       from_type    TEXT NOT NULL,
       to_type      TEXT NOT NULL,
       sent         INT  NOT NULL,
       new_leads    INT  NOT NULL,
       computed_at  BIGINT NOT NULL,
       PRIMARY KEY (ws_id, window_days, from_type, to_type)
     )`,
  )
  ready = true
}

function dateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d)
}
function windowRange(days: number): { start: string; end: string } {
  const end = new Date()
  const start = new Date(Date.now() - (days - 1) * 86400000)
  return { start: dateStr(start), end: dateStr(end) }
}

// Fetch new-lead + sent per combo for one workspace+window (9 slow calls).
async function fetchWs(wsId: string, days: number): Promise<Array<{ from_type: string; to_type: string; sent: number; new_leads: number }>> {
  const { start, end } = windowRange(days)
  const pairs: Array<{ p: string; r: string }> = []
  for (const p of ESP_CODES) for (const r of ESP_CODES) pairs.push({ p, r })
  const out = await Promise.all(
    pairs.map(async ({ p, r }) => {
      try {
        const url =
          `${PV_BASE}/account/email-stats?workspace_id=${wsId}&start_date=${start}&end_date=${end}` +
          `&provider=${p}&recp_provider=${r}`
        const res = await fetch(url, { headers: { 'x-api-key': PV_KEY }, signal: AbortSignal.timeout(60000) })
        if (!res.ok) return null
        const h = (await res.json())?.header ?? {}
        return {
          from_type: SENDER_LABEL[p],
          to_type: RECIP_LABEL[r],
          sent: h.total_sent_count ?? 0,
          new_leads: h.total_new_lead_contacted_count ?? 0,
        }
      } catch {
        return null
      }
    }),
  )
  return out.filter((x): x is NonNullable<typeof x> => x !== null)
}

async function storeWs(
  wsId: string,
  days: number,
  rows: Array<{ from_type: string; to_type: string; sent: number; new_leads: number }>,
): Promise<void> {
  const now = Date.now()
  for (const row of rows) {
    await pool
      .query(
        `INSERT INTO combo_newlead_cache (ws_id, window_days, from_type, to_type, sent, new_leads, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ws_id, window_days, from_type, to_type)
           DO UPDATE SET sent=$5, new_leads=$6, computed_at=$7`,
        [wsId, days, row.from_type, row.to_type, row.sent, row.new_leads, now],
      )
      .catch(() => {})
  }
}

// Recompute one workspace across the given windows (used on-demand + nightly).
export async function recomputeWorkspace(wsId: string, windows: readonly number[] = STANDARD_WINDOWS): Promise<void> {
  await ensureTable()
  if (!PV_KEY) return
  for (const days of windows) {
    const rows = await fetchWs(wsId, days)
    await storeWs(wsId, days, rows)
  }
}

let running = false
// Nightly: recompute ALL active workspaces for standard windows. Slow (~11 min);
// runs in the background. Concurrency kept low so we don't hammer PV.
export async function recomputeAll(windows: readonly number[] = STANDARD_WINDOWS): Promise<{ workspaces: number }> {
  await ensureTable()
  if (!PV_KEY || running) return { workspaces: 0 }
  running = true
  try {
    const wsSet = await getActiveWorkspaceIds().catch(() => null)
    const { rows } = await pool.query<{ ws_id: string }>(
      `SELECT workspace_id AS ws_id FROM workspace_stats WHERE workspace_id IS NOT NULL AND workspace_id <> ''`,
    )
    let ids = rows.map((r) => r.ws_id)
    if (wsSet) ids = ids.filter((id) => wsSet.has(id))
    const CONC = 3
    for (let i = 0; i < ids.length; i += CONC) {
      const batch = ids.slice(i, i + CONC)
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(batch.map((id) => recomputeWorkspace(id, windows)))
    }
    return { workspaces: ids.length }
  } finally {
    running = false
  }
}

// Read the cached split. workspaceId omitted → agency (sum across workspaces).
export async function readSplit(
  windowDays: number,
  workspaceId?: string,
): Promise<{ combos: Array<{ from_type: string; to_type: string; sent: number; new_leads: number }>; computed_at: number | null }> {
  await ensureTable()
  const params: unknown[] = [windowDays]
  let wsFilter = ''
  if (workspaceId) {
    params.push(workspaceId)
    wsFilter = 'AND ws_id = $2'
  }
  const { rows } = await pool.query(
    `SELECT from_type, to_type,
            SUM(sent)::int AS sent, SUM(new_leads)::int AS new_leads,
            MAX(computed_at) AS computed_at
       FROM combo_newlead_cache
      WHERE window_days = $1 ${wsFilter}
      GROUP BY from_type, to_type`,
    params,
  )
  return {
    combos: rows.map((r) => ({
      from_type: r.from_type as string,
      to_type: r.to_type as string,
      sent: +r.sent || 0,
      new_leads: +r.new_leads || 0,
    })),
    computed_at: rows.length ? Math.max(...rows.map((r) => Number(r.computed_at) || 0)) : null,
  }
}
