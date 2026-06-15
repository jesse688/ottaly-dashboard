import pool from '@/lib/db'
import type { PoolClient } from 'pg'

// Resolve the owning client for a workspace, using the SAME precedence as
// mark-as-lead (app/api/admin/unibox/[id]/mark-as-lead): a workspace CAN map to
// more than one client, so we deterministically pick the active-most, oldest
// client. Returns null for an unmapped/unknown workspace.
//
// Pass a transaction client (`q`) to resolve inside an existing BEGIN; defaults
// to the shared pool otherwise. This is the single source of truth for
// per-reply client identity — webhook intake, the reconciler, and mark-as-lead
// must all agree, or the firehose zoom and billing disagree about who owns a reply.
export async function resolveClientId(
  workspaceId: string | null | undefined,
  q: Pick<PoolClient, 'query'> = pool,
): Promise<string | null> {
  if (!workspaceId) return null
  const r = await q.query(
    `SELECT id FROM portal_clients
      WHERE workspace_id = $1
      ORDER BY active DESC, created_at ASC
      LIMIT 1`,
    [workspaceId],
  )
  return r.rows[0]?.id ?? null
}
