import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getPlusVibeReceived, type PVReceivedEmail } from '@/lib/plusvibe'
import { detectWarmupFull } from '@/lib/classify'
import { resolveClientId } from '@/lib/clients'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── PlusVibe unibox reconciler — THE reply ingest path ───────────────────────
// Ottaly uses PlusVibe ONLY (Bison/EmailBison is retired and its API returns
// nothing). Replies live in the PlusVibe unibox API. This cron pulls received
// emails per workspace and upserts them into unibox_replies so they flow through
// classify → Review. There is no working webhook — SCHEDULE this every ~15 min.
//
// Auth ?secret=CRON_SECRET. ?days=N window (default 3, max 90). ?ws=<id> one workspace.
const BOUNCE_RE = /(^|[._-])(mailer-daemon|postmaster|no-?reply|bounce|abuse)@/
// PlusVibe's own labels that mean "automated, not a human reply".
const PV_OOO_LABELS = new Set(['OUT_OF_OFFICE', 'AUTOMATIC_REPLY', 'AUTO_REPLY'])

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 90)
  const sinceMs = Date.now() - days * 86400_000
  const onlyWs = url.searchParams.get('ws')

  // Active client workspaces (PlusVibe workspace_id lives on portal_clients).
  const wsRows = await pool.query(
    `SELECT DISTINCT workspace_id FROM portal_clients WHERE workspace_id IS NOT NULL AND workspace_id <> ''`
  )
  const workspaces = (wsRows.rows as { workspace_id: string }[])
    .map(r => r.workspace_id)
    .filter(w => !onlyWs || w === onlyWs)

  const summary = { workspaces: 0, seen: 0, inserted: 0, healed: 0, ooo: 0, skipped_warmup: 0, skipped_bounce: 0, skipped_old: 0, errors: [] as string[] }

  for (const ws of workspaces) {
    summary.workspaces++
    const clientId = await resolveClientId(ws)
    let emails: PVReceivedEmail[] = []
    try {
      emails = await getPlusVibeReceived(ws, { sinceMs })
    } catch (err) {
      summary.errors.push(`${ws}: ${String(err).slice(0, 100)}`)
      continue
    }

    for (const e of emails) {
      const received = e.timestamp_created ? Date.parse(e.timestamp_created) : NaN
      if (!Number.isNaN(received) && received < sinceMs) { summary.skipped_old++; continue }
      summary.seen++

      const lead = (e.lead || e.from_address_email || '').toLowerCase()
      if (!lead || BOUNCE_RE.test(lead)) { summary.skipped_bounce++; continue }

      // Warm-up filter (our tags) — defensive; PV usually keeps warm-up out of received.
      const warm = await detectWarmupFull(ws, { subject: e.subject ?? '', bodyText: e.content_preview ?? '' })
      if (warm.isWarmup) { summary.skipped_warmup++; continue }

      // Trust PV's OOO/automatic label → file straight to the OOO folder (no AI).
      // Everything else lands in REVIEW as pending so it's VISIBLE immediately; the
      // classify worker then refines it (interested stays, not_interested/other move).
      const label = (e.label ?? '').toUpperCase()
      const isOoo = PV_OOO_LABELS.has(label)
      const category = isOoo ? 'ooo_auto_reply' : null
      const folder = isOoo ? 'ooo' : 'review'
      const state = isOoo ? 'done' : 'pending'

      const ins = await pool.query(
        `INSERT INTO unibox_replies
           (bison_team_id, bison_reply_id, workspace_id, client_id, lead_email, sender_email,
            subject, body_preview, classify_state, folder, category, raw, received_at,
            ingest_source, mailbox_email, campaign_id, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,'pv-api',$13,$14,NOW())
         ON CONFLICT (bison_team_id, bison_reply_id) DO UPDATE SET
           last_seen_at  = NOW(),
           workspace_id  = COALESCE(unibox_replies.workspace_id, EXCLUDED.workspace_id),
           client_id     = COALESCE(unibox_replies.client_id, EXCLUDED.client_id),
           mailbox_email = COALESCE(unibox_replies.mailbox_email, EXCLUDED.mailbox_email),
           updated_at    = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          ws, `pv_${e.id}`, ws, clientId, lead,
          e.subject ?? null, e.content_preview?.slice(0, 500) ?? null,
          state, folder, category, JSON.stringify(e),
          e.timestamp_created ?? new Date().toISOString(),
          e.eaccount ?? null, e.campaign_id ?? null,
        ]
      ).catch(err => { console.error(`[pv-reconcile] upsert failed ws=${ws} id=${e.id}:`, err); return null })

      if (!ins) continue
      if (ins.rows[0]?.inserted === true) { summary.inserted++; if (isOoo) summary.ooo++ }
      else summary.healed++
    }
  }

  await pool.query(
    `INSERT INTO esp_sync_log (source, status, leads_synced, finished_at) VALUES ($1,$2,$3,NOW())`,
    ['pv-reconcile', summary.errors.length === 0 ? 'success' : 'partial', summary.inserted]
  ).catch(() => {})

  return NextResponse.json({ ok: true, days, ...summary })
}
