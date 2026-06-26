import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { getPlusVibeWorkspaces } from '@/lib/plusvibe'
import pool from '@/lib/db'

// Workspaces available to attach a new client to.
//
// PRIMARY SOURCE = the live PlusVibe workspaces API (the source of truth). This
// lists every REAL workspace by name, so the admin picks "BlueHawk" and gets the
// correct id automatically — a free-typed/wrong id (how an API key once got
// pasted into the workspace field) becomes impossible. Workspaces already
// attached to a client are excluded.
//
// FALLBACK (PV API unreachable) = derive from workspace_ids that appear in our
// own data so the dropdown is never empty.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Already-attached workspaces — excluded from the picker either way.
  const takenRes = await pool.query(
    `SELECT DISTINCT workspace_id FROM portal_clients WHERE workspace_id IS NOT NULL AND workspace_id <> ''`
  ).catch(() => ({ rows: [] as { workspace_id: string }[] }))
  const taken = new Set((takenRes.rows as { workspace_id: string }[]).map(r => r.workspace_id))

  // Live PlusVibe workspaces (source of truth).
  const pv = await getPlusVibeWorkspaces()
  if (pv.length) {
    const rows = pv
      .filter(w => !taken.has(w.id))
      .map(w => ({ id: w.id, name: w.name, active_campaigns: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json(rows)
  }

  // Fallback: derive from our own data if PV is unreachable.
  const res = await pool.query(`
    WITH ws AS (
      -- esp_workspaces (if/when populated) — best source of a real name.
      SELECT id AS workspace_id, name FROM esp_workspaces
      UNION ALL
      SELECT workspace_id, NULL FROM esp_campaigns WHERE workspace_id IS NOT NULL AND workspace_id <> ''
      UNION ALL
      SELECT workspace_id, NULL FROM esp_leads WHERE workspace_id IS NOT NULL AND workspace_id <> ''
      UNION ALL
      SELECT workspace_id, NULL FROM unibox_replies WHERE workspace_id IS NOT NULL AND workspace_id <> ''
      UNION ALL
      -- Workspaces that only have ingested email threads yet (no campaigns/leads
      -- synced) would otherwise be invisible.
      SELECT workspace_id, NULL FROM portal_emails WHERE workspace_id IS NOT NULL AND workspace_id <> ''
    ),
    named AS (
      SELECT workspace_id,
             -- Prefer a real esp_workspaces name; otherwise fall back to the id.
             COALESCE(MAX(name) FILTER (WHERE name IS NOT NULL AND name <> ''), MAX(workspace_id)) AS name
      FROM ws GROUP BY workspace_id
    )
    SELECT n.workspace_id AS id,
           n.name,
           COALESCE((SELECT COUNT(*) FROM esp_campaigns c
                       WHERE c.workspace_id = n.workspace_id AND c.status = 'active'), 0) AS active_campaigns
    FROM named n
    -- Hide workspaces that are already attached to a client.
    WHERE NOT EXISTS (SELECT 1 FROM portal_clients pc WHERE pc.workspace_id = n.workspace_id)
    ORDER BY n.name ASC
  `).catch(async () => {
    // Some installs may lack one of the esp_* tables — fall back to the unibox
    // feed alone, which the portal always owns.
    return pool.query(`
      SELECT DISTINCT workspace_id AS id, workspace_id AS name, 0 AS active_campaigns
      FROM unibox_replies
      WHERE workspace_id IS NOT NULL AND workspace_id <> ''
        AND NOT EXISTS (SELECT 1 FROM portal_clients pc WHERE pc.workspace_id = unibox_replies.workspace_id)
      ORDER BY 1 ASC
    `)
  })

  return NextResponse.json(res.rows)
}
