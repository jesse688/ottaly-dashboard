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

    // Determine staleness.
    // Webhooks are EVENT-DRIVEN: they only fire when a lead actually replies, so
    // "no webhook in the last hour" is normal, not a fault. We key webhook health
    // off the most recent inbound email landing in portal_emails (the real "is
    // data flowing" signal) OR a logged webhook event, whichever is newer.
    // Polling is SCHEDULED, so a long gap there IS a real problem.
    const lastWebhookLog = lastSyncs.rows.find(r => r.source === 'plusvibe-webhook' || r.source === 'bison-webhook')
    const lastPolling = lastSyncs.rows.find(r => r.source === 'bison-polling' || r.source === 'plusvibe-polling')

    const lastInbound = await pool.query(
      `SELECT MAX(COALESCE(timestamp_created, synced_at)) AS last_in FROM portal_emails WHERE direction = 'IN'`
    ).catch(() => ({ rows: [{ last_in: null }] }))

    const webhookTimes = [lastWebhookLog?.last_finished, lastInbound.rows[0]?.last_in]
      .filter(Boolean).map(t => new Date(t as string).getTime())
    const newestWebhook = webhookTimes.length ? Math.max(...webhookTimes) : null

    let webhookStatus = 'idle'   // configured, just nothing recent — not an error
    let pollingStatus = 'unknown'
    let alert = ''

    if (newestWebhook) {
      const ageHrs = (now.getTime() - newestWebhook) / 1000 / 60 / 60
      // Replies are sporadic — only flag if NOTHING has arrived in a long while.
      webhookStatus = ageHrs < 24 ? 'healthy' : ageHrs < 72 ? 'idle' : 'stale'
    }

    if (lastPolling?.last_finished) {
      const age = (now.getTime() - new Date(lastPolling.last_finished).getTime()) / 1000 / 60
      pollingStatus = age < 60 ? 'healthy' : age < 180 ? 'stale' : 'down'
    }

    if (pollingStatus === 'down') {
      alert = '⚠️ Polling hasn’t run recently — check the sync cron'
    } else if (webhookStatus === 'stale' && pollingStatus !== 'healthy') {
      alert = '⚠️ No replies have synced in days — verify the Bison webhook'
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
