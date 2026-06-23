import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import {
  PV_TO_BISON_TEAM,
  withTeam,
  getUntrackedReplies,
  BISON_CONFIGURED,
  type BisonReply,
} from '@/lib/bison'
import { resolveClientId } from '@/lib/clients'
import { detectWarmupFull } from '@/lib/classify'

// ── PlusVibe "Other" (untracked) reply reconciler ────────────────────────────
// Campaign-tracked replies are ingested by the Bison webhook + unibox-reconcile
// cron. Replies that arrive on a connected mailbox but aren't linked to any
// campaign sequence have tracked_reply:false — Bison's "Untracked Reply" type —
// and appear in PlusVibe's "Other/Untracked" folder.
//
// These are missed entirely by the main pipeline. This cron fetches them from
// each Bison workspace and upserts into unibox_replies so they flow through the
// normal classify → triage → mark-as-lead path.
//
// Keys:  bison_team_id = Bison team id (from PV_TO_BISON_TEAM)
//        bison_reply_id = Bison reply id (integer, stored as TEXT)
//        ingest_source  = 'pv-other'
//
// Auth: ?secret=CRON_SECRET. Schedule every 15 min alongside unibox-reconcile.
// ?days=N widens the window (default 3, max 90).

const BOUNCE_RE = /(^|[._-])(mailer-daemon|postmaster|no-?reply|bounce|abuse)@/

// Warm-up detection reuses the SINGLE source of truth in lib/classify
// (detectWarmupFull = PlusVibe warm-up tags + the Bison warm-up codes), so this
// reconciler can never drift from the rest of the unibox. Bison warm-up traffic
// that lands in the "Other" folder is dropped here at ingest; the classify pass
// applies the same filter again as a backstop.

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ready()

  if (!BISON_CONFIGURED) {
    return NextResponse.json({ ok: true, skipped: 'bison_not_configured' })
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 90)
  const sinceMs = Date.now() - days * 86400_000
  // ?team=5 restricts the run to one Bison team (much faster when chasing a
  // specific workspace's backlog instead of sweeping all 21).
  const onlyTeam = url.searchParams.get('team')
  // ?include_tracked=1 also pulls TRACKED replies (campaign replies Bison may have
  // flagged not-interested) so our own classifier judges them — recovers leads
  // Bison's flag would otherwise hide. Default false (untracked-only, as before).
  const includeTracked = url.searchParams.get('include_tracked') === '1'

  const summary = {
    teams: 0, seen: 0, inserted: 0, healed: 0,
    skipped_warmup: 0, skipped_bounce: 0, skipped_old: 0,
    errors: [] as string[],
  }

  for (const [workspaceId, teamId] of Object.entries(PV_TO_BISON_TEAM)) {
    if (onlyTeam && teamId !== onlyTeam) continue
    summary.teams++
    const clientId = await resolveClientId(workspaceId)

    let replies: BisonReply[] = []
    try {
      replies = await withTeam(teamId, () => getUntrackedReplies(sinceMs, includeTracked))
    } catch (err) {
      summary.errors.push(`team ${teamId}: ${String(err).slice(0, 120)}`)
      continue
    }

    for (const r of replies) {
      // Date window filter
      const received = r.date_received ? Date.parse(r.date_received) : NaN
      if (!Number.isNaN(received) && received < sinceMs) { summary.skipped_old++; continue }

      summary.seen++

      const sender = (r.from_email_address ?? '').toLowerCase()
      if (!sender || BOUNCE_RE.test(sender)) { summary.skipped_bounce++; continue }
      const warm = await detectWarmupFull(workspaceId, {
        subject: r.subject ?? '',
        bodyText: r.text_body ?? '',
        rawText: r.html_body ?? '',
      })
      if (warm.isWarmup) { summary.skipped_warmup++; continue }

      const replyId = String(r.id)
      const subject = r.subject ?? null
      const bodyPreview = (r.text_body ?? r.html_body?.replace(/<[^>]+>/g, ' ') ?? '').slice(0, 500) || null
      const receivedAt = r.date_received ?? new Date().toISOString()
      const mailbox = (r.primary_to_email_address ?? '').toLowerCase() || null

      const ins = await pool.query(
        `INSERT INTO unibox_replies
           (bison_team_id, bison_reply_id, workspace_id, client_id, lead_email, sender_email,
            subject, body_preview, classify_state, folder, raw, received_at,
            ingest_source, mailbox_email, bison_interested, bison_automated_reply,
            campaign_id, sender_email_id, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','inbox',$9,$10,'pv-other',$11,$12,$13,$14,$15,NOW())
         ON CONFLICT (bison_team_id, bison_reply_id) DO UPDATE SET
           last_seen_at  = NOW(),
           workspace_id  = COALESCE(unibox_replies.workspace_id,  EXCLUDED.workspace_id),
           client_id     = COALESCE(unibox_replies.client_id,     EXCLUDED.client_id),
           mailbox_email = COALESCE(unibox_replies.mailbox_email, EXCLUDED.mailbox_email),
           updated_at    = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          teamId, replyId, workspaceId, clientId,
          sender, sender,
          subject, bodyPreview,
          JSON.stringify(r), receivedAt, mailbox,
          typeof r.interested === 'boolean' ? r.interested : null,
          typeof r.automated_reply === 'boolean' ? r.automated_reply : null,
          r.campaign_id != null ? String(r.campaign_id) : null,
          r.sender_email_id != null ? String(r.sender_email_id) : null,
        ]
      ).catch(err => {
        console.error(`[pv-other] upsert failed team=${teamId} reply=${replyId}:`, err)
        return null
      })

      if (!ins) continue
      if (ins.rows[0]?.inserted === true) summary.inserted++
      else summary.healed++
    }
  }

  await pool.query(
    `INSERT INTO esp_sync_log (source, status, leads_synced, finished_at) VALUES ($1,$2,$3,NOW())`,
    ['pv-other-reconcile', summary.errors.length === 0 ? 'success' : 'partial', summary.inserted]
  ).catch(() => {})

  return NextResponse.json({ ok: true, days, ...summary })
}
