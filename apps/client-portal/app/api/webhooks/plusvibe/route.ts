import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import crypto from 'crypto'
import { notifyClientOfLead } from '@/lib/email'
import { enrichLead } from '@/lib/sync'
import { ready } from '@/lib/db'

interface BisonWebhookPayload {
  event: {
    type: string
    workspace_id?: string | number
    workspace_name?: string
  }
  data: {
    lead?: {
      id?: string | number
      email?: string
      first_name?: string
      last_name?: string
      company_name?: string
      status?: string
      campaign_id?: string | number
      [key: string]: unknown
    }
    reply?: {
      id?: string | number
      lead_id?: string | number
      folder?: string
      html_body?: string
      text_body?: string
      subject?: string
      from_email_address?: string
      primary_to_email_address?: string
      date_received?: string
      raw_message_id?: string
      [key: string]: unknown
    }
  }
}

function verifySignature(payload: string, signature: string): boolean {
  const secret = process.env.BISON_WEBHOOK_SECRET || process.env.PLUSVIBE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhook] BISON_WEBHOOK_SECRET not configured — rejecting webhook')
    return false
  }
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  const exp = Buffer.from(computed)
  const sig = Buffer.from(signature)
  if (sig.length !== exp.length) return false
  return crypto.timingSafeEqual(exp, sig)
}

export async function POST(req: NextRequest) {
  await ready()
  const body = await req.text()
  const signature =
    req.headers.get('x-bison-signature') ||
    req.headers.get('x-webhook-signature') ||
    req.headers.get('x-plusvibe-signature') || ''

  if (!verifySignature(body, signature)) {
    console.warn('[webhook] Invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    const event = JSON.parse(body) as BisonWebhookPayload
    const eventType = event.event?.type ?? ''
    const workspaceId = event.event?.workspace_id ? String(event.event.workspace_id) : 'bison-default'
    const lead = event.data?.lead
    const reply = event.data?.reply

    console.log(`[webhook] received event: ${eventType} workspace: ${workspaceId}`)

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
          [
            leadId, workspaceId,
            lead.campaign_id ? String(lead.campaign_id) : null,
            lead.email, lead.first_name ?? null, lead.last_name ?? null,
            lead.company_name ?? null, lead.status ?? null,
            eventType === 'lead_replied' ? new Date().toISOString() : null,
          ]
        )
      }

      if (eventType === 'lead_interested') {
        try {
          await enrichLead(workspaceId, lead.email)
          if (leadId) await notifyClientOfLead(workspaceId, leadId)
        } catch (e) { console.error('[webhook] enrich/notify failed:', e) }
      }
    }

    // Cache inbound reply in portal_emails for thread display
    if (reply?.id && eventType !== 'lead_interested') {
      const leadEmail = lead?.email ?? ''
      const direction = reply.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
      if (leadEmail) {
        await pool.query(
          `INSERT INTO portal_emails (id, workspace_id, lead_pv_id, lead_email, direction, subject, body_html, body_text, content_preview, from_email, to_email, is_unread, message_id, timestamp_created, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO NOTHING`,
          [
            String(reply.id), workspaceId,
            lead?.id ? String(lead.id) : null,
            leadEmail.toLowerCase(), direction,
            reply.subject ?? null, reply.html_body ?? null, reply.text_body ?? null,
            reply.text_body?.slice(0, 200) ?? null,
            reply.from_email_address ?? null, reply.primary_to_email_address ?? null,
            direction === 'IN' ? 1 : 0,
            reply.raw_message_id ?? null,
            reply.date_received ?? null,
            JSON.stringify(reply),
          ]
        ).catch(err => console.error('[webhook] portal_emails insert failed:', err))
      }
    }

    await pool.query(
      `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['bison-webhook', workspaceId, 'success', 1]
    ).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
