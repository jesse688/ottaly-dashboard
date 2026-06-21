import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { enrichLeadFromContacts, applyCHRundownToLead } from '@/lib/enrich'

// Admin marks a Unibox reply as an "Info" lead: a near-lead that's worth showing
// the client but that we CANNOT charge for. It is pushed to the client dashboard
// (so they see it, badged "Info") but it must NEVER deduct from the lead balance.
//
// The billable path keys exclusively on esp_leads.label='INTERESTED'
// (reconcileLeadCharges). An Info lead gets label='INFO', so it is STRUCTURALLY
// excluded from charging — there is no code path here that touches portal_ledger.
// We deliberately do NOT call reconcileLeadCharges, tagInBison, or addToBlocklist:
// Info is not a conversion, so we don't mark it in Bison or stop outreach.
//
// Mirrors mark-as-lead's structure (lock reply, resolve nothing to bill, upsert
// the lead row, seed the thread, mark done) minus everything that costs money.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const { id } = await params

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sel = await client.query(
      `SELECT id, bison_reply_id, workspace_id, lead_bison_id, lead_email, subject,
              body_preview, received_at, marked_as_lead, label_type,
              raw->>'html_body'   AS reply_html,
              raw->>'text_body'   AS reply_text
         FROM unibox_replies WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!sel.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }
    const reply = sel.rows[0] as {
      id: string; bison_reply_id: string | null; workspace_id: string | null
      lead_bison_id: string | null; lead_email: string | null
      subject: string | null; body_preview: string | null; received_at: string | null
      marked_as_lead: boolean; label_type: string | null
      reply_html: string | null; reply_text: string | null
    }

    // Guard: a reply already billed as a real lead must NOT be silently downgraded
    // to Info here (that would leave a lead_charge with no INTERESTED lead). If the
    // admin wants to reverse a charge, that's the dispute/refund flow.
    if (reply.marked_as_lead && reply.label_type !== 'info') {
      await client.query('ROLLBACK')
      return NextResponse.json(
        { error: 'Already marked as a billable lead — use a dispute to reverse the charge.' },
        { status: 409 }
      )
    }

    if (!reply.workspace_id) {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'Reply is unmapped — no client workspace' }, { status: 409 })
    }

    // Seed the client-facing thread so the client can read what was written.
    // Same shape mark-as-lead uses; idempotent on id.
    async function seedThread(ws: string) {
      const email = (reply.lead_email ?? '').toLowerCase()
      if (!email) return
      const msgId = `unibox_${reply.bison_reply_id || reply.id}`
      await client.query(
        `INSERT INTO portal_emails
           (id, workspace_id, lead_pv_id, lead_email, direction, subject,
            body_html, body_text, content_preview, from_email, is_unread, timestamp_created, raw)
         VALUES ($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,1,$10,'{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           body_html       = COALESCE(EXCLUDED.body_html, portal_emails.body_html),
           body_text       = COALESCE(EXCLUDED.body_text, portal_emails.body_text),
           content_preview = COALESCE(EXCLUDED.content_preview, portal_emails.content_preview),
           subject         = COALESCE(portal_emails.subject, EXCLUDED.subject)`,
        [msgId, ws, reply.lead_bison_id, email, reply.subject,
         reply.reply_html, reply.reply_text ?? reply.body_preview,
         (reply.reply_text ?? reply.body_preview)?.slice(0, 200) ?? null, email, reply.received_at]
      ).catch((err) => { console.error('[mark-as-info] seedThread failed:', err); return null })
    }

    // Upsert the lead row with label='INFO'. Same id strategy as mark-as-lead
    // (lead_bison_id when present, else a synthetic id) and source='bison' so it
    // passes the dashboard's source filter. The INFO label keeps it out of
    // reconcileLeadCharges' WHERE clause forever.
    let leadRowId = reply.lead_bison_id
    if (reply.lead_bison_id || reply.lead_email) {
      if (!leadRowId) leadRowId = `manual_${reply.id}`
      await client.query(
        `INSERT INTO esp_leads
           (id, workspace_id, campaign_id, source, email,
            status, label, first_replied_at, created_at, updated_at)
         VALUES ($1,$2,NULL,'bison',$3,'INFO','INFO',NOW(),NOW(),NOW())
         ON CONFLICT (id, source) DO UPDATE SET
           -- Never downgrade a real INTERESTED lead to INFO on conflict.
           label  = CASE WHEN esp_leads.label = 'INTERESTED' THEN 'INTERESTED' ELSE 'INFO' END,
           status = CASE WHEN esp_leads.status = 'INTERESTED' THEN 'INTERESTED' ELSE 'INFO' END,
           first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
           updated_at = NOW()`,
        [leadRowId, reply.workspace_id, (reply.lead_email ?? '').toLowerCase() || null]
      )
      await seedThread(reply.workspace_id)
    }

    await client.query(
      `UPDATE unibox_replies
          SET marked_as_lead = TRUE, label_type = 'info', folder = 'done', marked_by = 'admin',
              marked_at = NOW(), bison_tag_state = 'na', updated_at = NOW()
        WHERE id = $1`,
      [id]
    )

    await client.query('COMMIT')

    // Enrich AFTER commit (best-effort). Pull our contacts record + the verified
    // CH rundown so the Info lead shows full company data to the client. NO
    // billing, NO Bison tag, NO blocklist — Info is not a conversion.
    if (leadRowId && reply.lead_email) {
      await enrichLeadFromContacts(leadRowId, reply.workspace_id, reply.lead_email).catch(() => {})
      await applyCHRundownToLead(leadRowId, reply.workspace_id, id).catch(() => {})
    }

    return NextResponse.json({ ok: true, label_type: 'info', leadId: leadRowId })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[admin/unibox/mark-as-info] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    client.release()
  }
}
