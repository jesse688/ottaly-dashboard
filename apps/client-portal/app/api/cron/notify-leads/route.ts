import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { notifyClientOfLead } from '@/lib/email'

// GET /api/cron/notify-leads?secret=<CRON_SECRET>
// Failsafe sweeper (run every minute): emails the client for any INTERESTED lead
// that has no notification claim yet. The unique (client_id, lead_id) claim in
// notifyClientOfLead guarantees exactly-one email even if the webhook also fired.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ready()
  const missing = await pool.query(
    `SELECT DISTINCT l.id, l.workspace_id, COALESCE(l.first_replied_at, l.created_at) AS delivered_at
       FROM esp_leads l
       JOIN portal_clients pc ON pc.workspace_id = l.workspace_id AND pc.active = true
       LEFT JOIN portal_lead_notifications n ON n.client_id = pc.id AND n.lead_id = l.id
      WHERE l.source IN ('plusvibe', 'bison') AND (l.label = 'INTERESTED' OR l.status = 'INTERESTED')
        -- never email a client about leads that predate their account (blast guard)
        AND COALESCE(l.first_replied_at, l.created_at) >= pc.created_at
        AND (n.id IS NULL OR (n.status = 'failed' AND n.attempts < 5 AND n.next_retry_at <= NOW()))
      ORDER BY delivered_at DESC NULLS LAST
      LIMIT 25`
  )

  let sent = 0
  for (const row of missing.rows) {
    try {
      const r = await notifyClientOfLead(row.workspace_id, row.id)
      if (r.sent) sent++
    } catch (err) { console.error('[notify-leads] failed for', row.id, err) }
  }
  return NextResponse.json({ checked: missing.rows.length, sent })
}
