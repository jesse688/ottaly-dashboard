import pool from './db'

// ── ESP Inboxing Test engine ─────────────────────────────────────────────────
// Flow per workspace:
//   start()    → save current ESP setting, flip to BROAD (all senders → all
//                recipients), record a `running` test with ends_at = now+window.
//   finalize() → after the window, MEASURE each sender×recipient combo's OOO/
//                auto-reply RATE (a fast, high-volume inboxing signal), pick the
//                best sender per recipient (when confident), and flip ESP matching
//                to those winners. Recipients with too little signal keep their
//                prior setting and are flagged 'inconclusive'.
//   restore()  → put a workspace's ESP setting back to its captured prior value.
//
// Reads (stats) use the stable public x-api-key. Writes (get/update ESP setting)
// use PlusVibe's INTERNAL api.pipl.ai + a short-lived JWT supplied at start and
// stored on the test row so the delayed finalize/restore can still write.
//
// On boot, resumeDueTests() finalizes any `running` test already past its window
// (survives restarts so a client is never left stuck on broad).

const PV_PUBLIC = 'https://api.plusvibe.ai/api/v1'
const PIPL = 'https://api.pipl.ai/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

const ESP_VALUES = ['GOOGLE_WORKSPACE', 'MICROSOFT365', 'REGULAR_ACCOUNT'] as const
type Esp = (typeof ESP_VALUES)[number]

// Min test sends for a combo's OOO rate to count as a confident signal.
const MIN_CONFIDENT_SENDS = 30

export interface ComboResult {
  provider: Esp
  recp_provider: Esp
  sent: number
  ooo: number
  bounces: number
  ooo_rate: number // ooo / sent
}
export interface RecipientRec {
  recp_provider: Esp
  winner: Esp | null // best sender; null = inconclusive
  ooo_rate: number
  sent: number
  confident: boolean
}
export interface TestResult {
  combos: ComboResult[]
  recommendations: RecipientRec[]
}

interface EspEntry { recipient_esp: string; sender_esp: string[]; tag_ids: string }

// ── low-level PV calls ───────────────────────────────────────────────────────
async function pvStat(
  wsId: string,
  date: string,
  provider: Esp,
  recp: Esp,
): Promise<{ sent: number; ooo: number; bounces: number }> {
  const url =
    `${PV_PUBLIC}/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}` +
    `&provider=${provider}&recp_provider=${recp}`
  const res = await fetch(url, { headers: { 'x-api-key': PV_KEY }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`PV ${res.status}`)
  const h = (await res.json())?.header ?? {}
  return {
    sent: h.total_sent_count ?? 0,
    ooo: (h.total_ooo_reply_count ?? 0) + 0, // OOO/auto = inboxing signal
    bounces: h.total_bounce_count ?? 0,
  }
}

async function getEspSetting(wsId: string, jwt: string): Promise<EspEntry[]> {
  const res = await fetch(`${PIPL}/user/get-workspace-setting?workspace_id=${wsId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`get-workspace-setting ${res.status}`)
  const data = await res.json()
  const esp = data?.esp_setting ? data : data?.data?.esp_setting ? data.data : data?.data || data
  return esp?.esp_setting ?? []
}

async function putEspSetting(
  wsId: string,
  jwt: string,
  esp_setting: EspEntry[],
  maxLeadDomain = 0,
): Promise<void> {
  // PlusVibe 500s if max_lead_domain_per_day < 1 — only send it when enabled.
  const payload: Record<string, unknown> = {
    esp_setting,
    is_max_lead_domain_per_day: maxLeadDomain >= 1 ? 1 : 0,
  }
  if (maxLeadDomain >= 1) payload.max_lead_domain_per_day = maxLeadDomain
  const res = await fetch(`${PIPL}/user/update-workspace-setting?workspace_id=${wsId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`update-workspace-setting ${res.status}`)
}

function broadSetting(): EspEntry[] {
  // Every recipient may be sent to by every sender = full exploration.
  return ESP_VALUES.map((recipient_esp) => ({
    recipient_esp,
    sender_esp: [...ESP_VALUES],
    tag_ids: '',
  }))
}

// ── schema (idempotent; admin-new is the runtime) ───────────────────────────
let ready = false
async function ensureTable(): Promise<void> {
  if (ready) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS esp_inbox_tests (
       id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_name TEXT,
       status TEXT NOT NULL, started_at BIGINT NOT NULL, ends_at BIGINT NOT NULL,
       window_hours REAL NOT NULL, prior_setting JSONB, jwt TEXT, result JSONB,
       error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
     )`,
  )
  ready = true
}

function newId(wsId: string, now: number): string {
  return `${wsId}_${now}`
}

// ── public API ───────────────────────────────────────────────────────────────
export async function startTest(
  wsId: string,
  wsName: string,
  jwt: string,
  windowHours: number,
): Promise<{ id: string }> {
  await ensureTable()
  if (!jwt) throw new Error('Missing token')
  // Refuse a second concurrent running test for the same workspace.
  const existing = await pool.query(
    `SELECT id FROM esp_inbox_tests WHERE workspace_id = $1 AND status = 'running'`,
    [wsId],
  )
  if (existing.rows.length) throw new Error('A test is already running for this workspace')

  const prior = await getEspSetting(wsId, jwt) // capture BEFORE flipping
  await putEspSetting(wsId, jwt, broadSetting())

  const now = Date.now()
  const id = newId(wsId, now)
  const endsAt = now + windowHours * 3600_000
  await pool.query(
    `INSERT INTO esp_inbox_tests
       (id, workspace_id, workspace_name, status, started_at, ends_at, window_hours,
        prior_setting, jwt, created_at, updated_at)
     VALUES ($1,$2,$3,'running',$4,$5,$6,$7,$8,$4,$4)`,
    [id, wsId, wsName, now, endsAt, windowHours, JSON.stringify(prior), jwt],
  )
  scheduleFinalize(id, endsAt - now)
  return { id }
}

async function measure(wsId: string, startedAt: number): Promise<TestResult> {
  // The window may span a day boundary; email-stats is per-day, so union the
  // dates the window touched. In practice a ≤24h window is 1–2 dates.
  const dates = new Set<string>()
  for (let t = startedAt; t <= Date.now(); t += 6 * 3600_000) {
    dates.add(new Date(t).toISOString().slice(0, 10))
  }
  dates.add(new Date().toISOString().slice(0, 10))

  const combos: ComboResult[] = []
  for (const provider of ESP_VALUES) {
    for (const recp of ESP_VALUES) {
      let sent = 0,
        ooo = 0,
        bounces = 0
      for (const date of dates) {
        try {
          const s = await pvStat(wsId, date, provider, recp)
          sent += s.sent
          ooo += s.ooo
          bounces += s.bounces
        } catch {
          /* skip a failed day; partial signal is still usable */
        }
      }
      combos.push({
        provider,
        recp_provider: recp,
        sent,
        ooo,
        bounces,
        ooo_rate: sent > 0 ? ooo / sent : 0,
      })
    }
  }

  // Best sender per recipient by OOO rate, among combos with enough sends.
  const recommendations: RecipientRec[] = ESP_VALUES.map((recp) => {
    const forRecp = combos.filter((c) => c.recp_provider === recp && c.sent >= MIN_CONFIDENT_SENDS)
    if (!forRecp.length) {
      // fall back to the highest-volume combo just to report, but mark not confident
      const any = combos
        .filter((c) => c.recp_provider === recp)
        .sort((a, b) => b.sent - a.sent)[0]
      return {
        recp_provider: recp,
        winner: null,
        ooo_rate: any?.ooo_rate ?? 0,
        sent: any?.sent ?? 0,
        confident: false,
      }
    }
    const best = forRecp.reduce((a, b) => (b.ooo_rate > a.ooo_rate ? b : a))
    return {
      recp_provider: recp,
      winner: best.provider,
      ooo_rate: best.ooo_rate,
      sent: best.sent,
      confident: true,
    }
  })

  return { combos, recommendations }
}

export async function finalizeTest(id: string): Promise<void> {
  await ensureTable()
  const { rows } = await pool.query(`SELECT * FROM esp_inbox_tests WHERE id = $1`, [id])
  const test = rows[0]
  if (!test || test.status !== 'running') return

  const wsId = test.workspace_id as string
  const jwt = test.jwt as string
  const now = Date.now()

  try {
    const result = await measure(wsId, Number(test.started_at))

    // Build the new ESP setting: confident recipients → their winning sender;
    // inconclusive recipients → their prior sender_esp (no change).
    const prior: EspEntry[] = test.prior_setting || []
    const priorByRecp = new Map(prior.map((e) => [e.recipient_esp, e.sender_esp]))
    const esp_setting: EspEntry[] = ESP_VALUES.map((recp) => {
      const rec = result.recommendations.find((r) => r.recp_provider === recp)
      if (rec?.confident && rec.winner) {
        return { recipient_esp: recp, sender_esp: [rec.winner], tag_ids: '' }
      }
      // keep prior; default to broad if there was no prior entry
      return {
        recipient_esp: recp,
        sender_esp: priorByRecp.get(recp) ?? [...ESP_VALUES],
        tag_ids: '',
      }
    })

    await putEspSetting(wsId, jwt, esp_setting)
    await pool.query(
      `UPDATE esp_inbox_tests
         SET status='done', result=$2, jwt=NULL, updated_at=$3, error=NULL
       WHERE id=$1`,
      [id, JSON.stringify(result), now],
    )
  } catch (err) {
    // Write/measure failed (often: JWT expired). Leave a loud error state — the
    // workspace is still on BROAD, which is safe-ish (sends continue) but the UI
    // must surface it so the user restores manually with a fresh token.
    await pool.query(
      `UPDATE esp_inbox_tests SET status='error', error=$2, updated_at=$3 WHERE id=$1`,
      [id, err instanceof Error ? err.message : 'finalize failed', now],
    )
  }
}

// Manual restore (fresh token supplied) — used by the safety-net button when a
// test errored and the workspace is stuck on broad.
export async function restoreTest(id: string, jwt: string): Promise<void> {
  await ensureTable()
  const { rows } = await pool.query(`SELECT * FROM esp_inbox_tests WHERE id=$1`, [id])
  const test = rows[0]
  if (!test) throw new Error('test not found')
  const prior: EspEntry[] = test.prior_setting || []
  if (!prior.length) throw new Error('no prior setting captured to restore')
  await putEspSetting(test.workspace_id, jwt, prior)
  await pool.query(
    `UPDATE esp_inbox_tests SET status='done', jwt=NULL, error='restored to prior', updated_at=$2 WHERE id=$1`,
    [id, Date.now()],
  )
}

// In-process timers (best-effort; resumeDueTests covers restarts).
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleFinalize(id: string, delayMs: number): void {
  if (timers.has(id)) clearTimeout(timers.get(id)!)
  const t = setTimeout(() => {
    timers.delete(id)
    finalizeTest(id).catch(() => {})
  }, Math.max(0, delayMs))
  timers.set(id, t)
}

// On boot: finalize any running test already past its window; re-arm timers for
// running tests still within their window. Never leaves a test un-finalized.
export async function resumeDueTests(): Promise<void> {
  await ensureTable()
  const { rows } = await pool.query(`SELECT id, ends_at FROM esp_inbox_tests WHERE status='running'`)
  const now = Date.now()
  for (const r of rows) {
    if (Number(r.ends_at) <= now) await finalizeTest(r.id).catch(() => {})
    else scheduleFinalize(r.id, Number(r.ends_at) - now)
  }
}

// Kick off resume on server import (once).
let resumed = false
if (typeof window === 'undefined') {
  if (!resumed) {
    resumed = true
    setTimeout(() => {
      resumeDueTests().catch(() => {})
    }, 8000)
  }
}
