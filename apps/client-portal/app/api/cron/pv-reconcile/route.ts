import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getPlusVibeReceived, type PVReceivedEmail } from '@/lib/plusvibe'
import { detectWarmupFull } from '@/lib/classify'
import { resolveClientId } from '@/lib/clients'
import { notifyClientOfLeadReply } from '@/lib/email'

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

// PlusVibe classifies every reply itself (label). We TRUST that label to route at
// ingest — so classification never depends on Gemini (which 429s/503s). Gemini is
// only a fallback refinement for replies PV left unlabelled.
//   done  = trust PV, no AI needed.   pending = let the classify worker refine.
function routeFromPvLabel(label: string): { category: string | null; folder: string; state: 'done' | 'pending' } {
  switch (label) {
    case 'INTERESTED':
    case 'MEETING_BOOKED':      return { category: 'interested',     folder: 'review',         state: 'done' }
    case 'QUESTION':            return { category: 'question',       folder: 'review',         state: 'done' }
    case 'NOT_INTERESTED':      return { category: 'not_interested', folder: 'not_interested', state: 'done' }
    case 'UNSUBSCRIBE':
    case 'UNSUBSCRIBED':
    case 'DO_NOT_CONTACT':      return { category: 'unsubscribe',    folder: 'unsubscribe',    state: 'done' }
    case 'OUT_OF_OFFICE':
    case 'AUTOMATIC_REPLY':
    case 'AUTO_REPLY':          return { category: 'ooo_auto_reply', folder: 'ooo',            state: 'done' }
    // Unknown / no PV label → Review as pending so it's VISIBLE now; the AI refines
    // it later if/when Gemini is available. Never hidden, never Gemini-blocked.
    default:                    return { category: null,            folder: 'review',         state: 'pending' }
  }
}

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

  type Counts = { seen: number; inserted: number; healed: number; ooo: number; skipped_warmup: number; skipped_bounce: number; skipped_old: number }
  const zero = (): Counts => ({ seen: 0, inserted: 0, healed: 0, ooo: 0, skipped_warmup: 0, skipped_bounce: 0, skipped_old: 0 })
  const errors: string[] = []

  // Process ONE workspace: fetch its PlusVibe received emails and upsert them.
  async function processWs(ws: string): Promise<Counts> {
    const c = zero()
    const clientId = await resolveClientId(ws)
    let emails: PVReceivedEmail[] = []
    try {
      emails = await getPlusVibeReceived(ws, { sinceMs })
    } catch (err) {
      errors.push(`${ws}: ${String(err).slice(0, 100)}`)
      return c
    }

    for (const e of emails) {
      const received = e.timestamp_created ? Date.parse(e.timestamp_created) : NaN
      if (!Number.isNaN(received) && received < sinceMs) { c.skipped_old++; continue }
      c.seen++

      const lead = (e.lead || e.from_address_email || '').toLowerCase()
      if (!lead || BOUNCE_RE.test(lead)) { c.skipped_bounce++; continue }

      const warm = await detectWarmupFull(ws, { subject: e.subject ?? '', bodyText: e.content_preview ?? '' })
      if (warm.isWarmup) { c.skipped_warmup++; continue }

      // Route by PV's own label (no Gemini dependency). Unlabelled → Review pending.
      const { category, folder, state } = routeFromPvLabel((e.label ?? '').toUpperCase())
      const isOoo = folder === 'ooo'

      // Key on the RFC Message-ID when present (stable per email) so PlusVibe
      // returning the same reply under two internal ids can't create a duplicate;
      // fall back to PV's id.
      const dedupeKey = `pv_${e.message_id || e.id}`

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
          ws, dedupeKey, ws, clientId, lead,
          e.subject ?? null, e.content_preview?.slice(0, 500) ?? null,
          state, folder, category, JSON.stringify(e),
          e.timestamp_created ?? new Date().toISOString(),
          e.eaccount ?? null, e.campaign_id ?? null,
        ]
      ).catch(err => { console.error(`[pv-reconcile] upsert failed ws=${ws} id=${e.id}:`, err); return null })

      if (!ins) continue
      const isNew = ins.rows[0]?.inserted === true
      if (isNew) { c.inserted++; if (isOoo) c.ooo++ } else { c.healed++; continue }

      // FIRST INGEST ONLY (the cron re-runs every minute — never re-seed/re-notify):
      // 1) Seed the CLIENT-FACING thread (portal_emails) so the lead's reply shows
      //    in the client dashboard and the lead surfaces as "needs reply".
      // 2) Notify the client if they were already in conversation with this lead.
      // Keyed on the Message-ID so it can never duplicate in the client thread.
      const bodyHtml = e.body?.html ?? e.html_body ?? null
      const bodyText = e.body?.text ?? e.text_body ?? e.content_preview ?? null
      await pool.query(
        `INSERT INTO portal_emails
           (id, workspace_id, lead_email, direction, subject, body_html, body_text,
            content_preview, from_email, to_email, is_unread, message_id, timestamp_created, raw)
         VALUES ($1,$2,$3,'IN',$4,$5,$6,$7,$8,$9,1,$10,$11,$12::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [dedupeKey, ws, lead, e.subject ?? null, bodyHtml, bodyText,
         (bodyText ?? '').slice(0, 200) || null, e.from_address_email ?? lead, e.eaccount ?? null,
         e.message_id ?? null, e.timestamp_created ?? new Date().toISOString(), JSON.stringify(e)]
      ).catch(err => console.error('[pv-reconcile] portal_emails insert failed:', err))

      // Notify only for genuine human replies (not OOO/auto) where the client has
      // already sent at least one message to this lead — a live conversation.
      if (!isOoo) {
        const had = await pool.query(
          `SELECT 1 FROM portal_emails WHERE workspace_id=$1 AND lower(lead_email)=lower($2)
             AND direction='OUT' AND sent_via_portal=true LIMIT 1`,
          [ws, lead]
        ).catch(() => ({ rows: [] as unknown[] }))
        if (had.rows.length) {
          void notifyClientOfLeadReply(ws, lead, lead, (bodyText ?? '').slice(0, 300), dedupeKey)
        }
      }
    }
    return c
  }

  // Run workspaces in PARALLEL batches so the whole sweep finishes in seconds
  // (sequential 20-workspace runs were blowing past cron-job.org's 30s timeout).
  const CONC = 6
  const totals = zero()
  for (let i = 0; i < workspaces.length; i += CONC) {
    const results = await Promise.all(workspaces.slice(i, i + CONC).map(processWs))
    for (const c of results) {
      totals.seen += c.seen; totals.inserted += c.inserted; totals.healed += c.healed; totals.ooo += c.ooo
      totals.skipped_warmup += c.skipped_warmup; totals.skipped_bounce += c.skipped_bounce; totals.skipped_old += c.skipped_old
    }
  }
  const summary = { workspaces: workspaces.length, ...totals, errors }

  await pool.query(
    `INSERT INTO esp_sync_log (source, status, leads_synced, finished_at) VALUES ($1,$2,$3,NOW())`,
    ['pv-reconcile', summary.errors.length === 0 ? 'success' : 'partial', summary.inserted]
  ).catch(() => {})

  return NextResponse.json({ ok: true, days, ...summary })
}
