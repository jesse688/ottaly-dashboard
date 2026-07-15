import pool from './db'

// ── ESP settings audit ───────────────────────────────────────────────────────
// Two tables:
//   esp_change_log        — one row per WRITE we make (manual apply / inbox-test /
//                           restore), with before→after mapping + source.
//   esp_settings_snapshots — point-in-time capture of a workspace's live mapping,
//                           taken when the overview fetches it. Comparing the
//                           latest two snapshots detects changes made OUTSIDE this
//                           tool (edited directly in PlusVibe).
//
// A "mapping" is normalised to { GOOGLE_WORKSPACE:[senders], MICROSOFT365:[...],
// REGULAR_ACCOUNT:[...] } with sorted sender arrays, so equality checks are stable.

const ESP_VALUES = ['GOOGLE_WORKSPACE', 'MICROSOFT365', 'REGULAR_ACCOUNT']

export type Mapping = Record<string, string[]>
interface EspEntry { recipient_esp: string; sender_esp?: string[] }

let ready = false
async function ensureTables(): Promise<void> {
  if (ready) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS esp_change_log (
       id BIGSERIAL PRIMARY KEY,
       ws_id TEXT NOT NULL,
       ws_name TEXT,
       before_mapping JSONB,
       after_mapping JSONB,
       source TEXT NOT NULL,          -- manual | inbox-test | restore | external
       note TEXT,
       changed_at BIGINT NOT NULL
     )`,
  )
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_esp_change_ws ON esp_change_log (ws_id, changed_at DESC)`)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS esp_settings_snapshots (
       ws_id TEXT NOT NULL,
       mapping JSONB NOT NULL,
       captured_at BIGINT NOT NULL,
       PRIMARY KEY (ws_id, captured_at)
     )`,
  )
  ready = true
}

// esp_setting[] → normalised, comparable Mapping.
export function normalizeMapping(espSetting: EspEntry[] | undefined | null): Mapping {
  const m: Mapping = {}
  for (const recp of ESP_VALUES) m[recp] = []
  for (const e of espSetting ?? []) {
    if (!e?.recipient_esp) continue
    m[e.recipient_esp] = [...(e.sender_esp ?? [])].sort()
  }
  return m
}

export function mappingsEqual(a: Mapping, b: Mapping): boolean {
  for (const recp of ESP_VALUES) {
    const x = a[recp] ?? [],
      y = b[recp] ?? []
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false
  }
  return true
}

// Record a write we performed. `before`/`after` are normalised mappings.
export async function logEspChange(
  wsId: string,
  wsName: string | null,
  before: Mapping | null,
  after: Mapping | null,
  source: string,
  now: number,
  note?: string,
): Promise<void> {
  await ensureTables()
  // Skip logging no-op writes (before == after) to keep the log meaningful.
  if (before && after && mappingsEqual(before, after)) return
  await pool
    .query(
      `INSERT INTO esp_change_log (ws_id, ws_name, before_mapping, after_mapping, source, note, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [wsId, wsName, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, source, note ?? null, now],
    )
    .catch((e) => console.error('[esp-audit] logEspChange failed:', e))
}

// Store a snapshot of the live mapping and, if it differs from the previous
// snapshot, log an 'external' change (drift made outside this tool). Returns
// { drifted, previous } so the overview can flag it.
export async function snapshotAndDiff(
  wsId: string,
  wsName: string | null,
  live: Mapping,
  now: number,
): Promise<{ drifted: boolean; previous: Mapping | null }> {
  await ensureTables()
  const prevRow = await pool.query(
    `SELECT mapping FROM esp_settings_snapshots WHERE ws_id = $1 ORDER BY captured_at DESC LIMIT 1`,
    [wsId],
  )
  const previous: Mapping | null = prevRow.rows[0]?.mapping ?? null

  let drifted = false
  if (previous && !mappingsEqual(previous, live)) {
    // The live mapping changed since our last snapshot. If the most recent
    // change_log entry already matches this live mapping, it was OUR write (not
    // external) — don't double-log. Otherwise record an external change.
    const lastLog = await pool.query(
      `SELECT after_mapping FROM esp_change_log WHERE ws_id = $1 ORDER BY changed_at DESC LIMIT 1`,
      [wsId],
    )
    const lastAfter: Mapping | null = lastLog.rows[0]?.after_mapping ?? null
    if (!lastAfter || !mappingsEqual(lastAfter, live)) {
      drifted = true
      await logEspChange(wsId, wsName, previous, live, 'external', now, 'changed outside this tool')
    }
  }

  await pool
    .query(
      `INSERT INTO esp_settings_snapshots (ws_id, mapping, captured_at) VALUES ($1,$2,$3)
       ON CONFLICT (ws_id, captured_at) DO NOTHING`,
      [wsId, JSON.stringify(live), now],
    )
    .catch(() => {})

  return { drifted, previous }
}

export async function recentChanges(limit = 200): Promise<unknown[]> {
  await ensureTables()
  const { rows } = await pool.query(
    `SELECT id, ws_id, ws_name, before_mapping, after_mapping, source, note, changed_at
       FROM esp_change_log ORDER BY changed_at DESC LIMIT $1`,
    [limit],
  )
  return rows
}
