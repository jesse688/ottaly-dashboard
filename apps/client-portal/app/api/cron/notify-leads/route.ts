import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
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

  const missing = await pool.query(
    `SELECT l.id, l.workspace_id
       FROM esp_leads l
       JOIN portal_clients pc ON pc.workspace_id = l.workspace_id AND pc.active = true
      WHERE l.source = 'plusvibe' AND l.label = 'INTERESTED'
        AND NOT EXISTS (
          SELECT 1 FROM portal_lead_notifications n
           WHERE n.client_id = pc.id AND n.lead_id = l.id
        )
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
