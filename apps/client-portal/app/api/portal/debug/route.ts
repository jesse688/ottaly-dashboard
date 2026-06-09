import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })

  const results: Record<string, unknown> = {
    session: {
      clientId: session.clientId,
      workspaceId: session.workspaceId,
      companyName: session.companyName,
    }
  }

  try {
    // Total leads in this workspace (any source, any label)
    const total = await pool.query(
      'SELECT COUNT(*) FROM esp_leads WHERE workspace_id = $1',
      [session.workspaceId]
    )
    results.total_leads_in_workspace = Number(total.rows[0].count)

    // Leads with source=plusvibe
    const plusvibe = await pool.query(
      "SELECT COUNT(*) FROM esp_leads WHERE workspace_id = $1 AND source = 'plusvibe'",
      [session.workspaceId]
    )
    results.plusvibe_leads = Number(plusvibe.rows[0].count)

    // Leads with label set
    const labeled = await pool.query(
      "SELECT COUNT(*) FROM esp_leads WHERE workspace_id = $1 AND source = 'plusvibe' AND label IS NOT NULL",
      [session.workspaceId]
    )
    results.labeled_plusvibe_leads = Number(labeled.rows[0].count)

    // Sample of distinct labels
    const labels = await pool.query(
      "SELECT DISTINCT label, COUNT(*) FROM esp_leads WHERE workspace_id = $1 AND source = 'plusvibe' GROUP BY label ORDER BY count DESC",
      [session.workspaceId]
    )
    results.labels = labels.rows

    // Sample of distinct sources in this workspace
    const sources = await pool.query(
      'SELECT DISTINCT source, COUNT(*) FROM esp_leads WHERE workspace_id = $1 GROUP BY source ORDER BY count DESC',
      [session.workspaceId]
    )
    results.sources = sources.rows

    // Check portal_clients row
    const client = await pool.query(
      'SELECT id, workspace_id, company_name, hidden_labels, active FROM portal_clients WHERE id = $1',
      [session.clientId]
    )
    results.portal_client = client.rows[0]

    // All workspaces that have plusvibe leads with labels (to find the right workspace_id)
    const allWs = await pool.query(
      `SELECT workspace_id, COUNT(*) AS lead_count
       FROM esp_leads
       WHERE source = 'plusvibe' AND label IS NOT NULL
       GROUP BY workspace_id
       ORDER BY lead_count DESC
       LIMIT 20`
    )
    results.workspaces_with_plusvibe_leads = allWs.rows

  } catch (err) {
    results.error = String(err)
  }

  return NextResponse.json(results)
}
