import { NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// GET /api/admin/sync-status
// Returns sync health: last sync times, lead counts, recent errors
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const now = new Date()

    // Get last sync attempt for each type
    const lastSyncs = await pool.query(`
      SELECT source, MAX(finished_at) as last_finished, status, leads_synced
      FROM esp_sync_log
      WHERE finished_at > NOW() - INTERVAL '24 hours'
      GROUP BY source, status, leads_synced
      ORDER BY last_finished DESC
      LIMIT 10
    `)

    // Get lead counts by workspace
    const leadCounts = await pool.query(`
      SELECT w.id, w.name, COUNT(l.id) as lead_count
      FROM esp_workspaces w
      LEFT JOIN esp_leads l ON l.workspace_id = w.id AND l.source = 'plusvibe'
      WHERE w.source = 'plusvibe'
      GROUP BY w.id, w.name
      ORDER BY lead_count DESC
    `)

    // Get recent errors
    const errors = await pool.query(`
      SELECT source, workspace_id, error, finished_at
      FROM esp_sync_log
      WHERE error IS NOT NULL AND finished_at > NOW() - INTERVAL '6 hours'
      ORDER BY finished_at DESC
      LIMIT 20
    `)

    // Determine staleness
    const lastWebhook = lastSyncs.rows.find(r => r.source === 'plusvibe-webhook')
    const lastPolling = lastSyncs.rows.find(r => r.source === 'plusvibe-polling')

    let webhookStatus = 'unknown'
    let pollingStatus = 'unknown'
    let alert = ''

    if (lastWebhook?.last_finished) {
      const age = (now.getTime() - new Date(lastWebhook.last_finished).getTime()) / 1000 / 60
      webhookStatus = age < 60 ? 'healthy' : age < 120 ? 'stale' : 'down'
    }

    if (lastPolling?.last_finished) {
      const age = (now.getTime() - new Date(lastPolling.last_finished).getTime()) / 1000 / 60
      pollingStatus = age < 45 ? 'healthy' : age < 90 ? 'stale' : 'down'
    }

    if (webhookStatus === 'down' && pollingStatus === 'down') {
      alert = '⚠️ Both webhook and polling are down — data may be stale'
    } else if (webhookStatus === 'down') {
      alert = '⚠️ Webhook is down — relying on polling only'
    } else if (pollingStatus === 'down') {
      alert = '⚠️ Polling is down — relying on webhook only'
    }

    return NextResponse.json({
      status: {
        webhook: webhookStatus,
        polling: pollingStatus,
        alert,
        checked_at: now.toISOString()
      },
      lastSyncs: lastSyncs.rows,
      leadCounts: leadCounts.rows,
      recentErrors: errors.rows
    })
  } catch (err) {
    console.error('[sync-status]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
