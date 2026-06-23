import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { sendPlusVibeReply } from '@/lib/plusvibe'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/admin/retry-unsent-replies
// Re-sends portal replies that never went out (sent_live IS NULL or FALSE).
// Finds the latest inbound PlusVibe email for each lead and re-sends via PV.
// Safe to run multiple times — skips any where sent_live = TRUE.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry') === '1'

  // Find outbound portal replies that haven't been sent live.
  // sent_live IS NULL = pre-flag era (assumed unsent for PlusVibe era).
  // sent_live = FALSE = known failure.
  // Join to the latest inbound email for that lead to get the reply_to_id.
  const r = await pool.query(`
    SELECT
      pe_out.id          AS out_id,
      pe_out.workspace_id,
      pe_out.lead_email,
      pe_out.subject,
      pe_out.body_html,
      pe_out.body_text,
      pe_out.to_email,
      pe_out.eaccount,
      pe_out.timestamp_created,
      pc.company_name,
      (
        SELECT pe_in.id FROM portal_emails pe_in
         WHERE pe_in.workspace_id = pe_out.workspace_id
           AND lower(pe_in.lead_email) = lower(pe_out.lead_email)
           AND pe_in.direction = 'IN'
           AND pe_in.timestamp_created < pe_out.timestamp_created
         ORDER BY pe_in.timestamp_created DESC
         LIMIT 1
      ) AS reply_to_id
    FROM portal_emails pe_out
    JOIN portal_clients pc ON pc.workspace_id = pe_out.workspace_id
    WHERE pe_out.direction = 'OUT'
      AND pe_out.sent_via_portal = TRUE
      AND (pe_out.sent_live IS NULL OR pe_out.sent_live = FALSE)
    ORDER BY pe_out.timestamp_created DESC
    LIMIT 100
  `)

  const rows = r.rows as {
    out_id: string; workspace_id: string; lead_email: string
    subject: string; body_html: string | null; body_text: string | null
    to_email: string | null; eaccount: string | null
    timestamp_created: string; company_name: string; reply_to_id: string | null
  }[]

  const results: { out_id: string; company: string; lead: string; subject: string; status: string; reason?: string }[] = []

  for (const row of rows) {
    if (!row.reply_to_id) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, status: 'skipped', reason: 'no_inbound_email_found' })
      continue
    }
    if (!row.eaccount) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, status: 'skipped', reason: 'no_from_account' })
      continue
    }

    if (dryRun) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, status: 'would_send' })
      continue
    }

    const send = await sendPlusVibeReply({
      workspaceId: row.workspace_id,
      replyToId: row.reply_to_id,
      subject: row.subject,
      from: row.eaccount,
      to: row.to_email || row.lead_email,
      body: row.body_html || `<p>${(row.body_text || '').replace(/\n/g, '<br/>')}</p>`,
    })

    await pool.query(
      `UPDATE portal_emails SET sent_live = $1 WHERE id = $2`,
      [send.ok, row.out_id]
    ).catch(() => {})

    results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, status: send.ok ? 'sent' : 'failed', reason: send.reason })
  }

  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status === 'skipped').length

  return NextResponse.json({ dryRun, total: rows.length, sent, failed, skipped, results })
}
