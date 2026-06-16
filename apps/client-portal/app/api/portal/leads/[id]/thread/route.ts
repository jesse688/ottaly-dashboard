import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLeadRepliesByEmail, bisonTeamForWorkspace } from '@/lib/bison'
import { getLockedLeadIds } from '@/lib/balance'
import { extractSignatureFields, ALL_SIGNATURE_FIELDS, type SignatureField } from '@/lib/signature'
import { sanitizeEmailHtml } from '@/lib/sanitize-html'

// Pull contact details out of the lead's latest inbound email and OVERRIDE the
// stored values in esp_leads.raw (their own email is the freshest source). Which
// fields are scanned is the global 'signature_extract_fields' setting. Best-effort.
async function applySignatureExtraction(leadId: string, workspaceId: string, rows: Array<Record<string, unknown>>, leadEmail: string) {
  try {
    const cfg = await pool.query(`SELECT value FROM portal_settings WHERE key = 'signature_extract_fields'`)
    const raw = cfg.rows[0]?.value
    // Default to all fields when unset; empty string = feature disabled.
    const fields: SignatureField[] = raw === undefined
      ? ALL_SIGNATURE_FIELDS
      : String(raw).split(',').map(s => s.trim()).filter(Boolean) as SignatureField[]
    if (!fields.length) return
    // company_name was added to the extractor AFTER this setting was first saved, so a
    // pre-existing setting string lists only the original 5 fields and would never
    // extract company_name (→ the panel keeps the wrong agency name). Always include it.
    if (!fields.includes('company_name')) fields.push('company_name')

    const inbound = rows.filter(r => r.direction === 'IN')
    const latest = inbound[inbound.length - 1]
    if (!latest) return
    const body = String(latest.body_html || latest.body_text || '')
    const found = extractSignatureFields(body, fields, leadEmail)
    if (!Object.keys(found).length) return

    // company_name is a TOP-LEVEL esp_leads column (the others live in raw). Split it
    // out and write it to the column — overriding the stored value, which is often the
    // AGENCY's name from import rather than the lead's real company. The rest merge
    // into raw (right-wins, so fresh signature values override stale ones).
    const { company_name, ...rawFields } = found as Record<string, string>
    if (Object.keys(rawFields).length) {
      await pool.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(rawFields), leadId, workspaceId]
      )
    }
    if (company_name) {
      await pool.query(
        `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [company_name, leadId, workspaceId]
      )
    }
  } catch (err) {
    console.error('[thread] signature extraction failed:', err)
  }
}

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

  // Refresh contact details from the latest inbound email signature.
  await applySignatureExtraction(id, session.workspaceId, rows, leadEmail)

  // Auto-mark "responded" if the synced thread shows an OUTBOUND message after
  // the prospect's first inbound (i.e. someone — client or agency — replied,
  // whether in our portal OR in Bison). This moves the lead off "Needs reply"
  // without the client clicking anything. Stamp first_responded_at once.
  try {
    const firstInbound = rows.find(r => r.direction === 'IN')?.timestamp_created
    const respondedOut = rows.some(r =>
      r.direction === 'OUT' &&
      (r.sent_via_portal ||
        (firstInbound && r.timestamp_created && new Date(r.timestamp_created) > new Date(firstInbound)))
    )
    if (respondedOut) {
      await pool.query(
        `INSERT INTO portal_lead_data (lead_id, client_id, first_responded_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (lead_id, client_id) DO UPDATE
           SET first_responded_at = COALESCE(portal_lead_data.first_responded_at, NOW())`,
        [id, session.clientId]
      )
    }
  } catch (err) {
    console.error('[thread] responded-stamp failed:', err)
  }

  // Sanitize body_html for rendering. Messages WE composed in the portal are
  // already trusted; INBOUND mail is untrusted, so scrub it (strip scripts, neutralise
  // remote tracking images — the client can opt to load them). The full signature
  // (logos/photos/contact table) survives sanitization.
  const safeRows = rows.map(r => ({
    ...r,
    body_html_safe: r.body_html
      ? (r.sent_via_portal
          ? sanitizeEmailHtml(String(r.body_html), { blockRemoteImages: false })
          : sanitizeEmailHtml(String(r.body_html)))
      : null,
  }))

  return NextResponse.json(safeRows)
}
