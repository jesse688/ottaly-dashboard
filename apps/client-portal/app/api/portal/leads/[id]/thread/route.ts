import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getEmails } from '@/lib/plusvibe'

// GET — the real email conversation for a lead, newest-last.
// Reads cached portal_emails first; if empty, pulls live from PlusVibe and caches.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const leadRes = await pool.query(
    'SELECT id, email FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!leadRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const leadEmail: string = leadRes.rows[0].email

  async function readCache() {
    const r = await pool.query(
      `SELECT id, direction, subject, body_html, body_text, content_preview,
              from_email, to_email, eaccount, pv_label, message_id, sent_via_portal,
              timestamp_created
         FROM portal_emails
        WHERE workspace_id = $1 AND lower(lead_email) = lower($2)
        ORDER BY timestamp_created ASC NULLS FIRST`,
      [session!.workspaceId, leadEmail]
    )
    return r.rows
  }

  let rows = await readCache()

  // Nothing cached yet — fetch live from PlusVibe and store, then re-read.
  if (rows.length === 0) {
    try {
      const { data } = await getEmails(session.workspaceId, { lead: leadEmail })
      for (const m of data) {
        await pool.query(
          `INSERT INTO portal_emails (
             id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
             subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
             pv_label, is_unread, message_id, timestamp_created, raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id) DO NOTHING`,
          [
            m.id, session.workspaceId, m.lead_id ?? null, leadEmail.toLowerCase(),
            m.thread_id ?? null, m.campaign_id ?? null, m.direction ?? 'IN',
            m.subject ?? null, m.body?.html ?? null, m.body?.text ?? null,
            m.content_preview ?? null, m.from_address_email ?? null,
            m.to_address_email_list ?? null, m.eaccount ?? null,
            m.label ?? null, m.is_unread ?? 0, m.message_id ?? null,
            m.timestamp_created ?? null, JSON.stringify(m),
          ]
        )
      }
      rows = await readCache()
    } catch (err) {
      console.error('[thread] live fetch failed:', err)
    }
  }

  // Mark inbound as read now the client has opened the thread.
  await pool.query(
    `UPDATE portal_emails SET is_unread = 0
      WHERE workspace_id = $1 AND lower(lead_email) = lower($2) AND is_unread = 1`,
    [session.workspaceId, leadEmail]
  ).catch(() => {})

  return NextResponse.json(rows)
}
