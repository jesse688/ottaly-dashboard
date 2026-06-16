import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { reconcileLeadCharges } from '@/lib/balance'
import { addToBlocklist, bisonTeamForWorkspace, tagInBison } from '@/lib/bison'
import { notifyClientOfLead } from '@/lib/email'

// Admin marks a Unibox reply as a real lead. This is the ONLY path that sets
// esp_leads.label='INTERESTED' (which reconcileLeadCharges keys on to bill the
// client) — so it must be safe against double-charging and double-tagging.
//
// In a transaction: lock the reply, resolve the client, flip the lead to
// INTERESTED, reconcile charges ONCE, mark the row done. AFTER commit (so a
// Bison failure never rolls back the lead/charge): tag in Bison + notify client.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const { id } = await params

  // Optional client override from the picker.
  let overrideClientId: string | undefined
  try {
    const body = await req.json().catch(() => ({})) as { clientId?: string }
    if (body && typeof body.clientId === 'string' && body.clientId) overrideClientId = body.clientId
  } catch { /* no body */ }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sel = await client.query(
      `SELECT id, bison_reply_id, workspace_id, lead_bison_id, lead_email, subject,
              body_preview, received_at, marked_as_lead,
              raw->'reply'->>'html_body'   AS reply_html,
              raw->'reply'->>'text_body'   AS reply_text,
              raw->'lead'->>'first_name'  AS first_name,
              raw->'lead'->>'last_name'   AS last_name,
              raw->'lead'->>'company_name' AS company_name
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
      subject: string | null; body_preview: string | null; received_at: string | null; marked_as_lead: boolean
      reply_html: string | null; reply_text: string | null
      first_name: string | null; last_name: string | null; company_name: string | null
    }

    // Seed the client-facing thread (portal_emails) from the unibox reply so the
    // client can read what the lead actually wrote. The thread route keys on
    // (workspace_id, lower(lead_email)); for outside-Bison leads its live Bison
    // fetch finds nothing, leaving "No messages synced yet". Idempotent on id.
    async function seedThread(ws: string) {
      const email = (reply.lead_email ?? '').toLowerCase()
      if (!email) return
      const msgId = `unibox_${reply.bison_reply_id || reply.id}`
      await client.query(
        `INSERT INTO portal_emails
           (id, workspace_id, lead_pv_id, lead_email, direction, subject,
            body_html, body_text, content_preview, from_email, is_unread, timestamp_created, raw)
         VALUES ($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,1,$10,'{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [msgId, ws, reply.lead_bison_id, email, reply.subject,
         reply.reply_html, reply.reply_text ?? reply.body_preview,
         reply.body_preview, email, reply.received_at]
      ).catch((err) => { console.error('[mark-as-lead] seedThread failed:', err); return null })
    }

    // Idempotent: already marked → no double charge, no double tag. But HEAL the
    // esp_leads row first: rows marked before the upsert fix have marked_as_lead=TRUE
    // yet no INTERESTED lead (so they never reached the dashboard). Re-marking now
    // backfills them. The flip is label-only; charges are reconciled separately and
    // are idempotent, so this can't double-charge.
    if (reply.marked_as_lead) {
      if (reply.workspace_id && (reply.lead_bison_id || reply.lead_email)) {
        const healId = reply.lead_bison_id || `manual_${reply.id}`
        await client.query(
          `INSERT INTO esp_leads
             (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name,
              status, label, first_replied_at, created_at, updated_at)
           VALUES ($1,$2,NULL,'bison',$3,$4,$5,$6,'INTERESTED','INTERESTED',NOW(),NOW(),NOW())
           ON CONFLICT (id, source) DO UPDATE SET
             label = 'INTERESTED', status = 'INTERESTED', updated_at = NOW()`,
          [healId, reply.workspace_id, (reply.lead_email ?? '').toLowerCase() || null,
           reply.first_name, reply.last_name, reply.company_name]
        )
        await seedThread(reply.workspace_id)
      }
      await client.query('COMMIT')
      // Re-bill in case the original mark predated cost_per_lead / the lead row.
      const c = await pool.query(
        `SELECT id FROM portal_clients WHERE workspace_id = $1 ORDER BY active DESC, created_at ASC LIMIT 1`,
        [reply.workspace_id]
      ).catch(() => ({ rows: [] as { id: string }[] }))
      if (c.rows[0]?.id) await reconcileLeadCharges(c.rows[0].id).catch(() => {})
      return NextResponse.json({ ok: true, already: true, healed: true })
    }

    // Resolve the client. Prefer a valid override, else the workspace owner.
    let clientId: string | null = null
    let pvWorkspaceId: string | null = reply.workspace_id
    if (overrideClientId) {
      const c = await client.query(
        `SELECT id, workspace_id FROM portal_clients WHERE id = $1`,
        [overrideClientId]
      )
      if (c.rows.length) {
        clientId = c.rows[0].id as string
        pvWorkspaceId = c.rows[0].workspace_id as string
      }
    }
    if (!clientId) {
      if (!reply.workspace_id) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Reply is unmapped — no client workspace to bill' }, { status: 409 })
      }
      const c = await client.query(
        `SELECT id FROM portal_clients WHERE workspace_id = $1 ORDER BY active DESC, created_at ASC LIMIT 1`,
        [reply.workspace_id]
      )
      if (!c.rows.length) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'No client found for this workspace' }, { status: 409 })
      }
      clientId = c.rows[0].id as string
    }

    // Flip the lead to INTERESTED so reconcileLeadCharges bills it AND the client
    // dashboard (which reads esp_leads WHERE label='INTERESTED') shows it.
    //
    // The lead row may not exist yet: the Bison webhook only creates an esp_leads
    // row on lead_interested/lead_replied events, so a reply classified as
    // question/other — or one forwarded in from OUTSIDE Bison (no lead_bison_id) —
    // has a unibox row but NO lead to flip. An UPDATE there is a silent no-op and
    // the lead never reaches the dashboard. So we UPSERT: build the lead from the
    // unibox row, keyed on lead_bison_id when present, else a synthetic id derived
    // from the unibox row id. source='bison' so it passes the dashboard's
    // source IN ('plusvibe','bison') filter. We resolved the lead id earlier into
    // pvWorkspaceId; persist it back so charges/notify reference a stable id.
    let leadRowId = reply.lead_bison_id
    if (pvWorkspaceId && (reply.lead_bison_id || reply.lead_email)) {
      if (!leadRowId) leadRowId = `manual_${reply.id}`
      await client.query(
        `INSERT INTO esp_leads
           (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name,
            status, label, first_replied_at, created_at, updated_at)
         VALUES ($1,$2,NULL,'bison',$3,$4,$5,$6,'INTERESTED','INTERESTED',NOW(),NOW(),NOW())
         ON CONFLICT (id, source) DO UPDATE SET
           label = 'INTERESTED', status = 'INTERESTED',
           first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
           updated_at = NOW()`,
        [leadRowId, pvWorkspaceId, (reply.lead_email ?? '').toLowerCase() || null,
         reply.first_name, reply.last_name, reply.company_name]
      )
      await seedThread(pvWorkspaceId)
    }

    // Mark the reply done before charging so the row reflects the decision even
    // if reconcile is a no-op (e.g. cost_per_lead not set yet).
    await client.query(
      `UPDATE unibox_replies
          SET marked_as_lead = TRUE, folder = 'done', marked_by = 'admin',
              marked_at = NOW(), bison_tag_state = 'pending', updated_at = NOW()
        WHERE id = $1`,
      [id]
    )

    await client.query('COMMIT')

    // reconcileLeadCharges is idempotent (uq_ledger_lead_charge). Run ONCE, after
    // commit so it sees the committed INTERESTED label.
    let charges = 0
    try {
      charges = await reconcileLeadCharges(clientId)
    } catch (err) {
      console.error('[admin/unibox/mark-as-lead] reconcile failed:', err)
    }

    // Best-effort Bison tag + blocklist — never roll back the lead if either
    // fails. Tag marks the lead in Bison; blocklisting the email stops a real
    // lead from receiving further cold outreach.
    // 'na' = nothing to tag (lead never came from Bison, so no lead_bison_id) —
    // distinct from 'failed' (a real Bison lead whose tag call errored) so the UI
    // doesn't show a scary "failed" on outside-Bison leads.
    let tagState: 'done' | 'failed' | 'na' = reply.lead_bison_id ? 'failed' : 'na'
    if (reply.lead_bison_id && pvWorkspaceId) {
      const teamId = bisonTeamForWorkspace(pvWorkspaceId)
      if (teamId) {
        const t = await tagInBison(teamId, reply.lead_bison_id)
        tagState = t.ok ? 'done' : 'failed'
        if (!t.ok) console.error('[admin/unibox/mark-as-lead] tag failed:', t.reason)

        if (reply.lead_email) {
          const b = await addToBlocklist(teamId, reply.lead_email)
          if (!b.ok) console.error('[admin/unibox/mark-as-lead] blocklist failed:', b.reason)
        }
      }
    }
    await pool.query(`UPDATE unibox_replies SET bison_tag_state = $2, updated_at = NOW() WHERE id = $1`, [id, tagState])
      .catch(() => {})

    // Notify the client of the new lead (idempotent on its own). Fire for any lead
    // we successfully flipped — including outside-Bison leads (synthetic id).
    if (pvWorkspaceId && leadRowId) {
      try {
        await notifyClientOfLead(pvWorkspaceId, leadRowId)
      } catch (err) {
        console.error('[admin/unibox/mark-as-lead] notify failed:', err)
      }
    }

    return NextResponse.json({ ok: true, clientId, charges, bison_tag_state: tagState })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[admin/unibox/mark-as-lead] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    client.release()
  }
}
