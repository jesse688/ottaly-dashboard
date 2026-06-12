import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLeadRepliesByEmail, bisonTeamForWorkspace } from '@/lib/bison'
import { getLockedLeadIds } from '@/lib/balance'

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

  // Locked lead (delivered while out of credit) — the conversation stays hidden
  // until the client tops up. Never return its emails.
  const lockedIds = await getLockedLeadIds(session.clientId)
  if (lockedIds.has(id)) return NextResponse.json({ locked: true, messages: [] }, { status: 403 })

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

  // Nothing cached yet — fetch live from EmailBison and store, then re-read.
  if (rows.length === 0) {
    try {
      // Resolve by EMAIL within the client's Bison team: the stored esp_leads.id
      // may be a PlusVibe id (backfilled history) Bison won't recognise, and the
      // super-admin token must be switched into the right workspace first.
      const replies = await getLeadRepliesByEmail(
        leadEmail,
        bisonTeamForWorkspace(session.workspaceId)
      )
      for (const m of replies) {
        const direction = m.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
        await pool.query(
          `INSERT INTO portal_emails (
             id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
             subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
             pv_label, is_unread, message_id, timestamp_created, raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id) DO NOTHING`,
          [
            String(m.id), session.workspaceId,
            m.lead_id ? String(m.lead_id) : null,
            leadEmail.toLowerCase(),
            m.parent_id ? String(m.parent_id) : null,
            m.campaign_id ? String(m.campaign_id) : null,
            direction,
            m.subject ?? null, m.html_body ?? null, m.text_body ?? null,
            m.text_body?.slice(0, 200) ?? null,
            m.from_email_address ?? null, m.primary_to_email_address ?? null,
            null, m.interested ? 'INTERESTED' : null,
            m.read ? 0 : 1, m.raw_message_id ?? null,
            m.date_received ?? null, JSON.stringify(m),
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
