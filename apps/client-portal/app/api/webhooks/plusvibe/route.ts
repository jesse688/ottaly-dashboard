import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import crypto from 'crypto'
import { notifyClientOfLead } from '@/lib/email'
import { enrichLead } from '@/lib/sync'
import { ready } from '@/lib/db'

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

  if (!verifySignature(body, signature, bisonSecret, pvSecret)) {
    console.warn('[webhook] Invalid signature')
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
    reply?: { id?: string | number; lead_id?: string | number; folder?: string; html_body?: string; text_body?: string; subject?: string; from_email_address?: string; primary_to_email_address?: string; date_received?: string; raw_message_id?: string; [key: string]: unknown }
  }
}

async function handleBison(raw: Record<string, unknown>) {
  const ev = raw as unknown as BisonPayload
  const eventType = ev.event?.type ?? ''
  const workspaceId = ev.event?.workspace_id ? String(ev.event.workspace_id) : 'bison-default'
  const lead = ev.data?.lead
  const reply = ev.data?.reply

  console.log(`[webhook/bison] ${eventType} workspace=${workspaceId}`)

  if (lead?.email && (eventType === 'lead_interested' || eventType === 'lead_replied')) {
    const leadId = lead.id ? String(lead.id) : null
    if (leadId) {
      await pool.query(
        `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name, status, label, first_replied_at, created_at, updated_at)
         VALUES ($1,$2,$3,'bison',$4,$5,$6,$7,$8,'INTERESTED',$9,NOW(),NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = COALESCE(EXCLUDED.status, esp_leads.status),
           label = COALESCE(EXCLUDED.label, esp_leads.label),
           first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
           updated_at = NOW()`,
        [leadId, workspaceId, lead.campaign_id ? String(lead.campaign_id) : null,
         lead.email, lead.first_name ?? null, lead.last_name ?? null,
         lead.company_name ?? null, lead.status ?? null,
         eventType === 'lead_replied' ? new Date().toISOString() : null]
      )
    }

    if (eventType === 'lead_interested') {
      try {
        await enrichLead(workspaceId, lead.email)
        if (leadId) await notifyClientOfLead(workspaceId, leadId)
      } catch (e) { console.error('[webhook/bison] enrich/notify failed:', e) }
    }
  }

  if (reply?.id && eventType !== 'lead_interested') {
    const leadEmail = lead?.email ?? ''
    const direction = reply.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
    if (leadEmail) {
      await pool.query(
        `INSERT INTO portal_emails (id, workspace_id, lead_pv_id, lead_email, direction, subject, body_html, body_text, content_preview, from_email, to_email, is_unread, message_id, timestamp_created, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [String(reply.id), workspaceId, lead?.id ? String(lead.id) : null,
         leadEmail.toLowerCase(), direction,
         reply.subject ?? null, reply.html_body ?? null, reply.text_body ?? null,
         reply.text_body?.slice(0, 200) ?? null,
         reply.from_email_address ?? null, reply.primary_to_email_address ?? null,
         direction === 'IN' ? 1 : 0, reply.raw_message_id ?? null,
         reply.date_received ?? null, JSON.stringify(reply)]
      ).catch(err => console.error('[webhook/bison] portal_emails insert failed:', err))
    }
  }

  await pool.query(
    `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at) VALUES ($1,$2,$3,$4,NOW())`,
    ['bison-webhook', workspaceId, 'success', 1]
  ).catch(() => {})
}
