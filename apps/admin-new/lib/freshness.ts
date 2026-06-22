import { qOne } from './query'

/**
 * Maps each cache table to the column holding its last-sync timestamp.
 * Pages read from these tables; this tells the UI how fresh that data is so
 * a stale or never-synced cache shows "Not yet synced" instead of a silent 0.
 */
// NOTE: column names verified against the live DB (information_schema), not guessed.
const FRESHNESS_SOURCES: Record<string, string> = {
  workspace_stats: 'computed_at',
  mailbox_daily_stats: 'updated_at',
  domain_health: 'last_checked',
  contacts: 'updated_at',
  warmup_daily_stats: 'synced_at', // new table (approved) — uses synced_at per spec
  client_actions_cache: 'synced_at', // new table (approved)
  client_audience_profiles: 'generated_at', // new table (approved)
}

export interface FreshnessMeta {
  table: string
  syncedAt: string | null
}

/**
 * Returns the most recent sync time for a cache table (ISO string), or null
 * if the table has never been populated. Never throws to the page — a
 * freshness probe failing should not blank the page it annotates.
 */
export async function getCacheFreshness(table: string): Promise<FreshnessMeta> {
  const col = FRESHNESS_SOURCES[table]
  if (!col) return { table, syncedAt: null }
  try {
    const row = await qOne<{ ts: Date | null }>(
      `SELECT MAX(${col}) AS ts FROM ${table}`,
      [],
      { tag: `freshness:${table}`, timeoutMs: 3000 },
    )
    return { table, syncedAt: row?.ts ? new Date(row.ts).toISOString() : null }
  } catch {
    return { table, syncedAt: null }
  }
}
