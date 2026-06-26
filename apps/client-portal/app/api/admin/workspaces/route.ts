import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// Workspaces available to attach a new client to.
//
// We are on PlusVibe ONLY now. The old version read esp_workspaces WHERE
// source='plusvibe' — but nothing populates that table for PV, so the dropdown
// was empty and new clients couldn't be created. PlusVibe has no clean
// "list workspaces" API either.
//
// Fix: derive the list from EVERY workspace_id that actually appears in our own
// data — campaigns, leads, the unibox reply feed, and esp_workspaces if it
// happens to have rows. Pick the best human name we can find. This is
// dependency-free (no external call) and self-heals as PV data flows in.
//
// Workspaces already attached to a client are excluded so the dropdown only
// offers ones you can still add. A brand-new workspace with no data yet won't
// appear here — the form also accepts a manually-typed workspace_id for that.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
