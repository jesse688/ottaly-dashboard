import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import crypto from 'crypto'
import { notifyClientOfLead } from '@/lib/email'
import { enrichLead, leadCompanyOrNull } from '@/lib/sync'
import { ready } from '@/lib/db'
import { bisonTeamToWorkspace } from '@/lib/bison'
import { notifyAdmin } from '@/lib/notify'
import { resolveClientId } from '@/lib/clients'

// Verify HMAC-SHA256 against any of the provided secrets (tries each until one matches).
function verifySignature(payload: string, signature: string, ...secrets: (string | undefined)[]): boolean {
  if (!signature) return false
  for (const secret of secrets) {
    if (!secret) continue
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
    const exp = Buffer.from(computed)
    const sig = Buffer.from(signature)
    if (sig.length === exp.length && crypto.timingSafeEqual(exp, sig)) return true
  }
  return false
}

export async function POST(req: NextRequest) {
  await ready()
  const body = await req.text()
  const signature =
    req.headers.get('x-bison-signature') ||
    req.headers.get('x-webhook-signature') ||
    req.headers.get('x-plusvibe-signature') || ''

  const bisonSecret = process.env.BISON_WEBHOOK_SECRET
  const pvSecret = process.env.PLUSVIBE_WEBHOOK_SECRET

  // Bison's webhook-url registration doesn't let us set a shared secret, so its
  // deliveries are unsigned (or signed with a secret we don't hold). Hard-
  // rejecting those 401'd EVERY reply → nothing reached the unibox. So only
  // reject when a signature IS present AND invalid; accept unsigned deliveries
  // (the webhook URL is unguessable + the data is admin-only).
  if (signature && !verifySignature(body, signature, bisonSecret, pvSecret)) {
    console.warn('[webhook] signature present but invalid — rejecting')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>

    // Detect payload format: PlusVibe sends event as a string, Bison as an object.
    if (typeof parsed.event === 'string') {
      await handlePlusVibe(parsed)
    } else {
      await handleBison(parsed)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}

// ── PlusVibe payload ──────────────────────────────────────────────────────────

interface PVPayload {
  event: string
  workspace_id: string
  lead_id: string
  campaign_id?: string
  data: {
    status?: string; label?: string; has_replied?: boolean
    email?: string; first_name?: string; last_name?: string; company_name?: string
    [key: string]: unknown
  }
}

async function handlePlusVibe(raw: Record<string, unknown>) {
  const ev = raw as unknown as PVPayload
  const { event, workspace_id: workspaceId, lead_id: leadId, campaign_id } = ev
  const d = ev.data ?? {}

  console.log(`[webhook/pv] ${event} lead=${leadId} workspace=${workspaceId}`)

  const updates: Record<string, unknown> = {}
  if (d.status) updates.status = d.status
  if (d.label) updates.label = d.label
  if (d.has_replied) updates.first_replied_at = new Date().toISOString()
  if (d.email) updates.email = d.email
  if (d.first_name) updates.first_name = d.first_name
  if (d.last_name) updates.last_name = d.last_name
  if (d.company_name) updates.company_name = d.company_name

  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates).map((k, i) =>
      k === 'first_replied_at'
        ? `first_replied_at = COALESCE(first_replied_at, $${i + 1})`
        : `${k} = $${i + 1}`
    ).join(', ')
    const n = Object.keys(updates).length
    const params = [...Object.values(updates), new Date().toISOString(), leadId, workspaceId]

    const res = await pool.query(
      `UPDATE esp_leads SET ${setClauses}, updated_at = $${n + 1}
       WHERE id = $${n + 2} AND workspace_id = $${n + 3}`,
      params
    )
    if ((res.rowCount ?? 0) === 0) {
      await pool.query(
        `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, first_replied_at, created_at, updated_at)
         VALUES ($1,$2,$3,'plusvibe',$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = COALESCE(EXCLUDED.status, esp_leads.status),
           label = COALESCE(EXCLUDED.label, esp_leads.label),
           first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
           updated_at = NOW()`,
        [leadId, workspaceId, campaign_id ?? null,
         d.email ?? null, d.first_name ?? null, d.last_name ?? null, d.company_name ?? null,
         d.status ?? null, d.label ?? null,
         d.has_replied ? new Date().toISOString() : null]
      )
    }
  }

  await pool.query(
    `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at) VALUES ($1,$2,$3,$4,NOW())`,
    ['plusvibe-webhook', workspaceId, 'success', 1]
  ).catch(() => {})

  const becameLead = d.status === 'INTERESTED' || d.label === 'INTERESTED'
  if (becameLead && d.email) {
    try {
      await enrichLead(workspaceId, d.email as string)
      await notifyClientOfLead(workspaceId, leadId)
    } catch (e) { console.error('[webhook/pv] enrich/notify failed:', e) }
  }
}

// ── Bison payload ─────────────────────────────────────────────────────────────

interface BisonPayload {
  event: { type: string; workspace_id?: string | number; workspace_name?: string }
  data: {
    lead?: { id?: string | number; email?: string; first_name?: string; last_name?: string; company_name?: string; status?: string; campaign_id?: string | number; [key: string]: unknown }
    reply?: { id?: string | number; lead_id?: string | number; folder?: string; html_body?: string; text_body?: string; subject?: string; email_subject?: string; from_email_address?: string; primary_to_email_address?: string; date_received?: string; raw_message_id?: string; [key: string]: unknown }
  }
}

async function handleBison(raw: Record<string, unknown>) {
  const ev = raw as unknown as BisonPayload
  const eventType = ev.event?.type ?? ''
  // The payload carries the raw Bison team id. Reverse-map it to the PV
  // workspace_id the rest of the portal keys off (portal_clients.workspace_id).
  const rawTeamId = ev.event?.workspace_id != null ? String(ev.event.workspace_id) : ''
  const mappedWorkspaceId = rawTeamId ? bisonTeamToWorkspace(rawTeamId) : null
  // Use the mapped PV workspace_id everywhere downstream; only fall back to the
  // raw team id for log breadcrumbs when unmapped.
  const lead = ev.data?.lead
  const reply = ev.data?.reply

  console.log(`[webhook/bison] ${eventType} team=${rawTeamId} workspace=${mappedWorkspaceId ?? 'UNMAPPED'}`)

  // Ingest the lead record. Decoupled from billing: label stays NULL on ingest
  // (PRESERVED on conflict) — only the admin "Mark as lead" action sets
  // label='INTERESTED'. status is updated as-is. A reply ≠ a billable lead.
  if (lead?.email && (eventType === 'lead_interested' || eventType === 'lead_replied')) {
    const leadId = lead.id ? String(lead.id) : null
    if (leadId && mappedWorkspaceId) {
      await pool.query(
        `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, first_replied_at, created_at, updated_at)
         VALUES ($1,$2,$3,'bison',$4,$5,$6,$7,$8,NULL,$9,NOW(),NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = COALESCE(EXCLUDED.status, esp_leads.status),
           first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
           updated_at = NOW()`,
        [leadId, mappedWorkspaceId, lead.campaign_id ? String(lead.campaign_id) : null,
         lead.email, lead.first_name ?? null, lead.last_name ?? null,
         await leadCompanyOrNull(mappedWorkspaceId, lead.company_name), lead.status ?? null,
         eventType === 'lead_replied' ? new Date().toISOString() : null]
      )
    }
  }

  // Store + queue the reply. Return fast — NO Claude, NO Bison reads here; the
  // classify cron handles triage. We still cache the reply into portal_emails
  // (only under the CORRECT PV workspace_id) so existing thread views work.
  if (reply?.id && eventType !== 'lead_interested') {
    const leadEmail = (lead?.email ?? '').toLowerCase()
    const direction = reply.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
    const replyId = String(reply.id)
    const leadBisonId = lead?.id ? String(lead.id) : (reply.lead_id ? String(reply.lead_id) : null)
    // Bison's reply payload puts the subject in `email_subject` (not `subject`).
    const replySubject = reply.email_subject ?? reply.subject ?? null

    // The address that actually SENT this reply (may differ from the campaign
    // lead, e.g. forwarded to a colleague who replies from their own address).
    const senderEmail = (reply.from_email_address ?? '').toLowerCase()
    // The unibox row's primary email = the campaign lead if known, else the sender.
    const rowEmail = leadEmail || senderEmail

    // Cache the FULL reply (html + text body, with the lead's signature/photos) into
    // portal_emails so the client inbox can render it. Key on rowEmail (sender when
    // there's no attached lead) — previously this only ran when lead.email existed,
    // so UNATTACHED replies never got a portal_emails row and their signature was
    // lost. The thread route reads portal_emails by (workspace_id, lower(lead_email)).
    let portalEmailId: string | null = null
    if (rowEmail && mappedWorkspaceId) {
      const ins = await pool.query(
        `INSERT INTO portal_emails (id, workspace_id, lead_pv_id, lead_email, direction, subject, body_html, body_text, content_preview, from_email, to_email, is_unread, message_id, timestamp_created, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [replyId, mappedWorkspaceId, leadBisonId,
         rowEmail, direction,
         replySubject, reply.html_body ?? null, reply.text_body ?? null,
         reply.text_body?.slice(0, 200) ?? null,
         reply.from_email_address ?? null, reply.primary_to_email_address ?? null,
         direction === 'IN' ? 1 : 0, reply.raw_message_id ?? null,
         reply.date_received ?? null, JSON.stringify(reply)]
      ).catch(err => { console.error('[webhook/bison] portal_emails insert failed:', err); return null })
      if (ins) portalEmailId = replyId
    }

    // Master Unibox row — only inbound replies are worth triaging. Idempotent on
    // (bison_team_id, bison_reply_id) so webhook retries never duplicate.
    if (direction === 'IN' && rowEmail) {
      // #2 FORWARDED / UNLINKED: if the reply isn't tied to a known lead (no
      // lead.email, or the sender differs from the lead), try to match the
      // sender's DOMAIN to an existing lead in this client's workspace → that's
      // almost certainly the same company. Flag it forwarded and keep BOTH the
      // original matched lead and the actual sender.
      let isForwarded = false
      let matchedLeadEmail: string | null = null
      let matchedBy: string | null = null
      if (mappedWorkspaceId && senderEmail) {
        const senderDomain = senderEmail.split('@')[1] ?? ''
        const noLinkedLead = !leadEmail
        const senderDiffersFromLead = !!leadEmail && senderEmail !== leadEmail
        if ((noLinkedLead || senderDiffersFromLead) && senderDomain) {
          const m = await pool.query(
            `SELECT email FROM esp_leads
              WHERE workspace_id = $1 AND lower(split_part(email,'@',2)) = $2
              ORDER BY (lower(email) = $3) DESC, updated_at DESC LIMIT 1`,
            [mappedWorkspaceId, senderDomain, leadEmail || senderEmail]
          ).catch(() => ({ rows: [] as { email: string }[] }))
          if (m.rows[0]?.email) {
            isForwarded = true
            matchedLeadEmail = String(m.rows[0].email).toLowerCase()
            matchedBy = 'domain'
          }
        }
      }
      // Bison marks automated/warmup replies with automated_reply=true — drop them
      // at intake so they never enter the classify pipeline.
      if (reply.automated_reply === true) {
        console.log(`[webhook/bison] skipping automated reply id=${replyId}`)
        continue
      }
      const folder = mappedWorkspaceId ? 'inbox' : 'unmapped'
      const bisonInterested = typeof reply.interested === 'boolean' ? reply.interested : null
      const bisonAutomated = typeof reply.automated_reply === 'boolean' ? reply.automated_reply : null
      // Resolve the owning client ONCE at intake (same precedence as mark-as-lead)
      // so the firehose can scope/zoom on a stable client_id even when a workspace
      // maps to more than one client.
      const clientId = await resolveClientId(mappedWorkspaceId)
      await pool.query(
        // Idempotent on (bison_team_id, bison_reply_id). On a retry or a later,
        // richer delivery (e.g. an event that carries Bison's interested/automated
        // flags the first one lacked) we COALESCE-merge to backfill NULLs and
        // refresh Bison-owned facts — but NEVER touch category / admin_label /
        // folder / marked_as_lead, so a human or AI decision is never clobbered.
        `INSERT INTO unibox_replies
           (bison_team_id, bison_reply_id, workspace_id, client_id, portal_email_id, lead_email, lead_bison_id,
            subject, body_preview, classify_state, folder, raw, received_at,
            is_forwarded, sender_email, matched_lead_email, matched_by,
            ingest_source, bison_interested, bison_automated_reply,
            campaign_id, sender_email_id, mailbox_email, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15,$16,'webhook',$17,$18,$19,$20,$21,NOW())
         ON CONFLICT (bison_team_id, bison_reply_id) DO UPDATE SET
           bison_interested      = EXCLUDED.bison_interested,
           bison_automated_reply = EXCLUDED.bison_automated_reply,
           workspace_id          = COALESCE(unibox_replies.workspace_id, EXCLUDED.workspace_id),
           client_id             = COALESCE(unibox_replies.client_id, EXCLUDED.client_id),
           portal_email_id       = COALESCE(unibox_replies.portal_email_id, EXCLUDED.portal_email_id),
           received_at           = COALESCE(unibox_replies.received_at, EXCLUDED.received_at),
           raw                   = COALESCE(unibox_replies.raw, EXCLUDED.raw),
           campaign_id           = COALESCE(unibox_replies.campaign_id, EXCLUDED.campaign_id),
           sender_email_id       = COALESCE(unibox_replies.sender_email_id, EXCLUDED.sender_email_id),
           mailbox_email         = COALESCE(unibox_replies.mailbox_email, EXCLUDED.mailbox_email),
           last_seen_at          = NOW(),
           updated_at            = NOW()`,
        // rawTeamId is ALWAYS stored verbatim — never collapsed to a shared
        // 'unknown' constant, which made two distinct unmapped teams with the same
        // reply.id collide on ('unknown', id) and silently drop the second.
        [rawTeamId, replyId, mappedWorkspaceId, clientId, portalEmailId,
         // Primary email = the matched original lead if forwarded, else the row email.
         matchedLeadEmail || rowEmail, leadBisonId,
         replySubject, reply.text_body?.slice(0, 500) ?? null,
         folder, JSON.stringify(reply),
         reply.date_received ?? new Date().toISOString(),
         isForwarded, senderEmail || null, matchedLeadEmail, matchedBy,
         bisonInterested, bisonAutomated,
         reply.campaign_id != null ? String(reply.campaign_id) : null,
         reply.sender_email_id != null ? String(reply.sender_email_id) : null,
         // For an INBOUND reply, primary_to_email_address is our sending mailbox.
         (reply.primary_to_email_address ?? '').toLowerCase() || null]
      ).catch(err => console.error('[webhook/bison] unibox_replies insert failed:', err))

      // Alert admins once about a team we can't map to a client workspace.
      if (!mappedWorkspaceId) {
        await maybeNotifyUnmappedTeam(rawTeamId)
      }
    }
  }

  await pool.query(
    `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at) VALUES ($1,$2,$3,$4,NOW())`,
    ['bison-webhook', mappedWorkspaceId ?? `team:${rawTeamId}`, 'success', 1]
  ).catch(() => {})
}

// Notify admins at most once per unmapped Bison team (avoids a Slack storm when a
// new workspace starts replying before its portal_clients row exists). Dedup via
// a portal_meta marker keyed by team id.
async function maybeNotifyUnmappedTeam(teamId: string) {
  if (!teamId) return
  try {
    const key = `unibox_unmapped_team_${teamId}`
    const r = await pool.query(
      `INSERT INTO portal_meta (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key]
    )
    if (!r.rows.length) return // already notified
    await notifyAdmin({
      kind: 'dispute',
      title: `Unmapped Bison team ${teamId}`,
      body: `A reply arrived from Bison team ${teamId}, which isn't mapped to any client workspace (PV_TO_BISON_TEAM). It's parked in the Unibox "Unmapped" folder. Add the mapping to start routing this team's replies.`,
    })
  } catch (err) {
    console.error('[webhook/bison] unmapped-team notify failed:', err)
  }
}
