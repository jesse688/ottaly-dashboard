import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { sendPlusVibeReply } from '@/lib/plusvibe'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Fetch the first active email account address for a PlusVibe workspace.
// Cached per workspace for the lifetime of this request.
async function getWorkspaceFrom(workspaceId: string, cache: Map<string, string>): Promise<string | null> {
  if (cache.has(workspaceId)) return cache.get(workspaceId)!
  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.plusvibe.ai/api/v1/email-accounts?workspace_id=${encodeURIComponent(workspaceId)}&limit=1`,
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data = await res.json() as { data?: { from_name?: string; from_email?: string; email?: string }[] }
    const account = data?.data?.[0]
    const from = account?.from_email ?? account?.email ?? null
    if (from) cache.set(workspaceId, from)
    return from
  } catch {
    return null
  }
}

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

    // Resolve from address: DB value → PlusVibe workspace account lookup
    const from = row.eaccount || await getWorkspaceFrom(row.workspace_id, fromCache) || ''

    if (dryRun) {
      results.push({ out_id: row.out_id, company: row.company_name, lead: row.lead_email, subject: row.subject, sent_at: row.timestamp_created, status: 'would_send', reason: from ? `from:${from}` : 'no_from_unknown' })
      continue
    }

    const send = await sendPlusVibeReply({
      workspaceId: row.workspace_id,
      replyToId: row.reply_to_id,
      subject: row.subject,
      from: from || undefined,
      to: row.to_email || row.lead_email,
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
