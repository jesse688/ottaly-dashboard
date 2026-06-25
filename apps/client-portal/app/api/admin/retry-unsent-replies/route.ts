import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { sendPlusVibeReply, getPlusVibeInbound } from '@/lib/plusvibe'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/admin/retry-unsent-replies
// Re-sends portal replies that never went out (sent_live IS NULL or FALSE).
// ?dry=1  — preview only, no sends
// ?lead=email@example.com — only retry that one lead (for testing)
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry') === '1'
  const onlyLead = url.searchParams.get('lead') ?? null

  const r = await pool.query(`
    SELECT
      pe_out.id          AS out_id,
      pe_out.workspace_id,
      pe_out.lead_email,
      pe_out.subject,
      pe_out.body_html,
      pe_out.body_text,
      pe_out.to_email,
      COALESCE(pe_out.eaccount, pe_in.eaccount, pe_in.to_email) AS eaccount,
      pe_out.timestamp_created,
      pc.company_name,
      COALESCE(
        (SELECT pe_in2.id FROM portal_emails pe_in2
          WHERE pe_in2.workspace_id = pe_out.workspace_id
            AND lower(pe_in2.lead_email) = lower(pe_out.lead_email)
            AND pe_in2.direction = 'IN'
            AND pe_in2.id LIKE 'unibox_%'
            AND pe_in2.timestamp_created <= pe_out.timestamp_created
          ORDER BY pe_in2.timestamp_created DESC LIMIT 1),
        pe_in.id
      ) AS reply_to_id
    FROM portal_emails pe_out
    JOIN portal_clients pc ON pc.workspace_id = pe_out.workspace_id
    LEFT JOIN LATERAL (
      SELECT id, eaccount, to_email FROM portal_emails
       WHERE workspace_id = pe_out.workspace_id
         AND lower(lead_email) = lower(pe_out.lead_email)
         AND direction = 'IN'
         AND timestamp_created <= pe_out.timestamp_created
       ORDER BY timestamp_created DESC
       LIMIT 1
    ) pe_in ON true
    WHERE pe_out.direction = 'OUT'
      AND pe_out.sent_via_portal = TRUE
      AND (pe_out.sent_live IS NULL OR pe_out.sent_live = FALSE)
      AND pe_out.lead_email NOT LIKE 'test+%'
      AND pe_out.lead_email NOT LIKE '%@demo-co.example'
      ${onlyLead ? 'AND lower(pe_out.lead_email) = lower($1)' : ''}
    ORDER BY pe_out.timestamp_created DESC
    LIMIT 100
  `, onlyLead ? [onlyLead] : [])

  const rows = r.rows as {
    out_id: string; workspace_id: string; lead_email: string
    subject: string; body_html: string | null; body_text: string | null
    to_email: string | null; eaccount: string | null
    timestamp_created: string; company_name: string; reply_to_id: string | null
  }[]

  const fromCache = new Map<string, string>()
  const results: { out_id: string; company: string; lead: string; subject: string; sent_at: string; status: string; reason?: string }[] = []

  for (const row of rows) {
    if (!row.reply_to_id) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: 'skipped', reason: 'no_inbound_email_found' })
      continue
    }

    // Get the real PlusVibe email + correct from/to — our DB stores unibox_ IDs PV rejects
    // and NULL eaccount. Fall back to stripping the unibox_ prefix if the API lookup fails.
    const pvInbound = await getPlusVibeInbound(row.workspace_id, row.lead_email)
    const replyToId = pvInbound?.id ?? row.reply_to_id?.replace(/^unibox_/, '') ?? null
    let from = pvInbound?.from || row.eaccount || ''
    // Same fallback as the live reply route: recover the sending mailbox from
    // unibox_replies.mailbox_email (the address that RECEIVED the lead's reply)
    // when the inbound lookup + portal_emails.eaccount are both empty. Without
    // this, the retry skips with 'no_from_account' — the exact pv_400 cause.
    if (!from) {
      const mb = await pool.query(
        `SELECT mailbox_email FROM unibox_replies
          WHERE workspace_id = $1 AND lower(lead_email) = lower($2)
            AND mailbox_email IS NOT NULL AND mailbox_email <> ''
          ORDER BY received_at DESC LIMIT 1`,
        [row.workspace_id, row.lead_email]
      ).catch(() => ({ rows: [] as { mailbox_email?: string }[] }))
      from = mb.rows[0]?.mailbox_email || ''
    }
    const toAddr = pvInbound?.to || row.to_email || row.lead_email

    if (dryRun) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: 'would_send', reason: `reply_to:${replyToId ?? 'none'} from:${from || 'unknown'} to:${toAddr}` })
      continue
    }

    if (!replyToId) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: 'skipped', reason: 'no_pv_email_id' })
      continue
    }
    if (!from) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: 'skipped', reason: 'no_from_account' })
      continue
    }

    const send = await sendPlusVibeReply({
      workspaceId: row.workspace_id,
      replyToId,
      subject: row.subject,
      from: from || undefined,
      to: toAddr,
      body: row.body_html || `<p>${(row.body_text || '').replace(/\n/g, '<br/>')}</p>`,
    })

    await pool.query(
      `UPDATE portal_emails SET sent_live = $1 WHERE id = $2`,
      [send.ok, row.out_id]
    ).catch(() => {})

    results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: send.ok ? 'sent' : 'failed', reason: send.reason })
  }

  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status === 'skipped').length

  return NextResponse.json({ dryRun, total: rows.length, sent, failed, skipped, results })
}
