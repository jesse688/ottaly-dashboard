// EmailBison webhook handler.
// Bison sends: { event: { type, workspace_id, workspace_name }, data: { ... } }
// Key event types: lead_interested, lead_replied, untracked_reply_received
import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import { ready } from '@/lib/db'
import crypto from 'crypto'
import { enrichLead } from '@/lib/sync'

interface BisonWebhookEvent {
  event: {
    type: string
    name: string
    workspace_id: number
    workspace_name: string
  }
  data: {
    lead?: {
      id: number
      email: string
      first_name?: string | null
      last_name?: string | null
      company?: string | null
      status?: string | null
    }
    reply?: {
      id: number
      interested?: boolean
      lead_id?: number | null
      from_email_address?: string | null
      date_received?: string | null
    }
    [key: string]: unknown
  }
}

function verifySignature(payload: string, signature: string): boolean {
  const secret = process.env.BISON_WEBHOOK_SECRET || process.env.PLUSVIBE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhook] BISON_WEBHOOK_SECRET not configured — rejecting unsigned request')
    return false
  }
  try {
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
    const sigBuf = Buffer.from(signature.replace(/^sha256=/, ''), 'hex')
    const compBuf = Buffer.from(computed, 'hex')
    if (sigBuf.length !== compBuf.length) return false
    return crypto.timingSafeEqual(sigBuf, compBuf)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  await ready()

  const body = await req.text()
  const signature =
    req.headers.get('x-bison-signature') ||
    req.headers.get('x-webhook-signature') ||
    req.headers.get('x-plusvibe-signature') ||
    ''

  if (!verifySignature(body, signature)) {
    console.warn('[webhook] Invalid or missing signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    const event = JSON.parse(body) as BisonWebhookEvent
    const eventType = event.event?.type ?? ''
    const workspaceId = String(event.event?.workspace_id ?? '')
    const lead = event.data?.lead
    const reply = event.data?.reply

    console.log(`[webhook] ${eventType} workspace=${workspaceId} lead=${lead?.id ?? reply?.lead_id}`)

    if (lead) {
      const leadId = String(lead.id)
      const isInterested = eventType === 'lead_interested' || reply?.interested === true

      const updateRes = await pool.query(
        `UPDATE esp_leads SET
           email       = COALESCE(esp_leads.email, $1),
           first_name  = COALESCE(esp_leads.first_name, $2),
           last_name   = COALESCE(esp_leads.last_name, $3),
           company_name = COALESCE(esp_leads.company_name, $4),
           status      = CASE WHEN $5 THEN 'INTERESTED' ELSE COALESCE(esp_leads.status, $6) END,
           label       = CASE WHEN $5 THEN 'INTERESTED' ELSE esp_leads.label END,
           first_replied_at = COALESCE(esp_leads.first_replied_at, $7),
           source      = 'bison',
           updated_at  = NOW()
         WHERE id = $8 AND workspace_id = $9
         RETURNING id`,
        [
          lead.email,
          lead.first_name ?? null,
          lead.last_name ?? null,
          lead.company ?? null,
          isInterested,
          lead.status ?? null,
          reply?.date_received ?? new Date().toISOString(),
          leadId,
          workspaceId,
        ]
      )

      if (updateRes.rowCount === 0) {
        // Lead not in DB yet — insert it
        await pool.query(
          `INSERT INTO esp_leads (
             id, workspace_id, source,
             email, first_name, last_name, company_name,
             status, label, first_replied_at, created_at, updated_at
           ) VALUES ($1,$2,'bison',$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
           ON CONFLICT (id) DO UPDATE SET
             email=$3, first_name=$4, last_name=$5, company_name=$6,
             status=$7, label=$8, first_replied_at=COALESCE(esp_leads.first_replied_at,$9),
             source='bison', updated_at=NOW()`,
          [
            leadId, workspaceId,
            lead.email,
            lead.first_name ?? null,
            lead.last_name ?? null,
            lead.company ?? null,
            isInterested ? 'INTERESTED' : lead.status ?? null,
            isInterested ? 'INTERESTED' : null,
            reply?.date_received ?? new Date().toISOString(),
          ]
        )
      }

      if (isInterested) {
        await enrichLead(workspaceId, leadId)
      }
    }

    await pool.query(
      `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at)
       VALUES ('bison-webhook', $1, 'success', 1, NOW())`,
      [workspaceId]
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
