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

  // Bison's webhook-url registration doesn't let us set a shared secret, so its
  // deliveries are unsigned (or signed with a secret we don't hold). Hard-
  // rejecting those 401'd EVERY reply → nothing reached the unibox. So only
  // reject when a signature IS present AND invalid; accept unsigned deliveries
  // (the webhook URL is unguessable + the data is admin-only).
  if (signature && !verifySignature(body, signature, bisonSecret, pvSecret)) {
    console.warn('[webhook] signature present but invalid — rejecting')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Log EVERY delivery first (best-effort) so a reply that lands in Bison but not
  // the Unibox can be traced: did the webhook even arrive, and how did we route it?
  let deliveryId: string | null = null
  try {
    const probe = JSON.parse(body) as Record<string, unknown>
    const isBison = typeof probe.event !== 'string'
    const evObj = probe.event as { type?: string; workspace_id?: string | number } | undefined
    const data = probe.data as { reply?: { id?: string | number }; lead?: unknown } | undefined
    const ins = await pool.query(
      `INSERT INTO webhook_deliveries (provider, event_type, team_id, reply_id, signature_present, body, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,'received') RETURNING id`,
      [
        isBison ? 'bison' : 'plusvibe',
        isBison ? (evObj?.type ?? null) : String(probe.event ?? ''),
        isBison && evObj?.workspace_id != null ? String(evObj.workspace_id) : null,
        data?.reply?.id != null ? String(data.reply.id) : null,
        !!signature,
        body.slice(0, 20000),
      ]
    )
    deliveryId = ins.rows[0]?.id ?? null
  } catch { /* logging must never block intake */ }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>

    // Detect payload format: PlusVibe sends event as a string, Bison as an object.
    if (typeof parsed.event === 'string') {
      await handlePlusVibe(parsed)
      // PlusVibe path doesn't set its own outcome; mark it terminal here.
      if (deliveryId) await markDelivery(deliveryId, 'done:plusvibe')
    } else {
      // BISON IS RETIRED. We no longer ingest Bison webhook deliveries — replies
      // now come from the PlusVibe cron (/unibox/emails + /unibox/other-emails).
      // Ingesting Bison events too created DUPLICATE rows (raw_message_id, no PV
      // message_id) that fought the PV copies in the unibox and made items flicker
      // in/out. Log + acknowledge only; never ingest.
      if (deliveryId) await markDelivery(deliveryId, 'skipped:bison_retired')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    if (deliveryId) await markDelivery(deliveryId, `error:${String(err).slice(0, 200)}`)
    // ALWAYS return 200. A 500 makes Bison treat the delivery as failed and, after
    // repeated failures, auto-disable/back-off the webhook — which silently stops
    // ALL replies. We've logged the error for ourselves; never signal failure to Bison.
    return NextResponse.json({ ok: false, logged: true })
  }
}

// Mark 'done' only if the handler left the delivery in a non-terminal state
// (still 'received' or just 'routed:<event>') — preserves any specific outcome.

// Update a delivery's outcome (and workspace once we've mapped it). Best-effort.
async function markDelivery(id: string, outcome: string, workspaceId?: string | null) {
  await pool.query(
    `UPDATE webhook_deliveries SET outcome = $2, workspace_id = COALESCE($3, workspace_id) WHERE id = $1`,
    [id, outcome, workspaceId ?? null]
  ).catch(() => {})
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
         ON CONFLICT (id, source) DO UPDATE SET
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

  const becameLead = d.status === 'INTERESTED' || d.status === 'MEETING_BOOKED' || d.label === 'INTERESTED'
  if (becameLead && d.email) {
    try {
      await enrichLead(workspaceId, d.email as string)
      await notifyClientOfLead(workspaceId, leadId)
    } catch (e) { console.error('[webhook/pv] enrich/notify failed:', e) }
  }
}

