import { NextResponse, type NextRequest } from 'next/server'
import pool from '@/lib/db'
import crypto from 'crypto'
import { notifyClientOfLead } from '@/lib/email'

interface PlusVibeWebhookPayload {
  event: string
  timestamp: number
  workspace_id: string
  lead_id: string
  campaign_id?: string
  data: {
    status?: string
    label?: string
    has_replied?: boolean
    email?: string
    first_name?: string
    last_name?: string
    company_name?: string
    [key: string]: unknown
  }
}

// Verify PlusVibe webhook signature (HMAC-SHA256)
function verifySignature(payload: string, signature: string): boolean {
  const secret = process.env.PLUSVIBE_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[webhook] PLUSVIBE_WEBHOOK_SECRET not configured, skipping signature verification')
    return true
  }
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  const exp = Buffer.from(computed)
  const sig = Buffer.from(signature)
  // timingSafeEqual throws if lengths differ — guard so a malformed signature is
  // a clean rejection (401), not an uncaught RangeError (500).
  if (sig.length !== exp.length) return false
  return crypto.timingSafeEqual(exp, sig)
}

// POST /api/webhooks/plusvibe
// Receives real-time updates from PlusVibe (lead status, label, reply)
export async function POST(req: NextRequest) {
  const body = await req.text()
  const signature = req.headers.get('x-plusvibe-signature') || ''

  // Verify webhook signature
  if (!verifySignature(body, signature)) {
    console.warn('[webhook] Invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    const event = JSON.parse(body) as PlusVibeWebhookPayload
    console.log(`[webhook] received event: ${event.event} for lead ${event.lead_id}`)

    // Build update fields based on event type
    const updates: Record<string, unknown> = {}
    if (event.data.status) updates.status = event.data.status
    if (event.data.label) updates.label = event.data.label
    if (event.data.has_replied) updates.first_replied_at = new Date().toISOString() // On webhook, set to now
    if (event.data.email) updates.email = event.data.email
    if (event.data.first_name) updates.first_name = event.data.first_name
    if (event.data.last_name) updates.last_name = event.data.last_name
    if (event.data.company_name) updates.company_name = event.data.company_name

    // Never overwrite first_replied_at if already set
    const setClauses = Object.entries(updates)
      .map(([key], i) => {
        if (key === 'first_replied_at') {
          return `first_replied_at = COALESCE(first_replied_at, $${i + 1})`
        }
        return `${key} = $${i + 1}`
      })
      .join(', ')

    if (Object.keys(updates).length > 0) {
      // Param order: update fields ($1..$N), then timestamp, lead_id, workspace_id.
      // The bound array and the highest $N must match exactly.
      const n = Object.keys(updates).length
      const tsIdx = n + 1, idIdx = n + 2, wsIdx = n + 3
      const params = [...Object.values(updates), new Date().toISOString(), event.lead_id, event.workspace_id]

      // Upsert: update if exists, insert if not
      await pool.query(`
        UPDATE esp_leads
        SET ${setClauses}, updated_at = $${tsIdx}
        WHERE id = $${idIdx} AND workspace_id = $${wsIdx}
      `, params)

      // If no rows updated, insert
      const updateRes = await pool.query(`
        SELECT COUNT(*) FROM esp_leads WHERE id = $1 AND workspace_id = $2
      `, [event.lead_id, event.workspace_id])

      if (Number(updateRes.rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO esp_leads (
            id, workspace_id, campaign_id, source,
            email, first_name, last_name, company_name, status, label,
            first_replied_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `, [
          event.lead_id,
          event.workspace_id,
          event.campaign_id || null,
          'plusvibe',
          event.data.email || null,
          event.data.first_name || null,
          event.data.last_name || null,
          event.data.company_name || null,
          event.data.status || null,
          event.data.label || null,
          event.data.has_replied ? new Date().toISOString() : null,
        ])
      }
    }

    // Log webhook to audit trail
    await pool.query(`
      INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, ['plusvibe-webhook', event.workspace_id, 'success', 1])

    // New lead in the portal = a lead that became INTERESTED. Email the client
    // (once per lead — dedup is enforced inside notifyClientOfLead).
    const becameLead = event.data.status === 'INTERESTED' || event.data.label === 'INTERESTED'
    if (becameLead) {
      try {
        await notifyClientOfLead(event.workspace_id, event.lead_id)
      } catch (e) { console.error('[webhook] notify failed:', e) }
    }

    console.log(`[webhook] processed event: ${event.event}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
