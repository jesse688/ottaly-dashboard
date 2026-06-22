import { legacyFetch } from './api'

interface ClientStatusRow {
  workspace_id: string
  workspace_name: string
  client_status: string | null
  restart_date: string | null
}

/**
 * Returns the set of ACTIVE workspace_ids from the legacy app's single source of
 * truth (GET /api/client-status). Active/inactive lives in the legacy SQLite
 * `clients` table, not Postgres — so we proxy it.
 *
 * Used to hide inactive clients on every page EXCEPT Finance + Revenue
 * (those keep all clients for accounting/historical accuracy).
 *
 * Fails OPEN: if the status fetch errors, returns null → callers should show all
 * clients rather than hide everything (better stale-but-present than blank).
 */
export async function getActiveWorkspaceIds(): Promise<Set<string> | null> {
  try {
    const rows = (await legacyFetch('/api/client-status')) as ClientStatusRow[]
    if (!Array.isArray(rows)) return null
    return new Set(
      rows.filter(r => (r.client_status ?? 'active') !== 'inactive').map(r => r.workspace_id),
    )
  } catch {
    return null
  }
}
