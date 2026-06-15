import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { reconcileLeadCharges } from '@/lib/balance'
import { bisonTeamForWorkspace, tagInBison } from '@/lib/bison'
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
      `SELECT id, workspace_id, lead_bison_id, marked_as_lead FROM unibox_replies WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!sel.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }
    const reply = sel.rows[0] as {
      id: string; workspace_id: string | null; lead_bison_id: string | null; marked_as_lead: boolean
    }

    // Idempotent: already marked → no double charge, no double tag.
    if (reply.marked_as_lead) {
      await client.query('COMMIT')
      return NextResponse.json({ ok: true, already: true })
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

    // Flip the lead to INTERESTED so reconcileLeadCharges bills it.
    if (reply.lead_bison_id && pvWorkspaceId) {
      await client.query(
        `UPDATE esp_leads SET label = 'INTERESTED', status = 'INTERESTED', updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2`,
        [reply.lead_bison_id, pvWorkspaceId]
      )
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

    // Best-effort Bison tag — never roll back the lead because the tag failed.
    let tagState: 'done' | 'failed' = 'failed'
    if (reply.lead_bison_id && pvWorkspaceId) {
      const teamId = bisonTeamForWorkspace(pvWorkspaceId)
      if (teamId) {
        const t = await tagInBison(teamId, reply.lead_bison_id)
        tagState = t.ok ? 'done' : 'failed'
        if (!t.ok) console.error('[admin/unibox/mark-as-lead] tag failed:', t.reason)
      }
    }
    await pool.query(`UPDATE unibox_replies SET bison_tag_state = $2, updated_at = NOW() WHERE id = $1`, [id, tagState])
      .catch(() => {})

    // Notify the client of the new lead (idempotent on its own).
    if (pvWorkspaceId && reply.lead_bison_id) {
      try {
        await notifyClientOfLead(pvWorkspaceId, reply.lead_bison_id)
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
