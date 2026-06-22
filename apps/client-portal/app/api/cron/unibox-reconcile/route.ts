import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import {
  PV_TO_BISON_TEAM,
  withTeam,
  getCampaigns,
  getCampaignReplies,
  registerWebhookAllWorkspaces,
  BISON_INGEST_ENABLED,
  type BisonReply,
} from '@/lib/bison'
import { resolveClientId } from '@/lib/clients'

// ── Unibox reconciler ────────────────────────────────────────────────────────
// The real-time webhook (handleBison) is the primary path, but a single missed
// or malformed delivery is otherwise permanent. This cron re-pulls TRACKED
// replies from Bison per team and self-heals: it inserts replies the webhook
// missed and refreshes Bison-owned facts (interested/automated flags) on rows we
// already have — WITHOUT ever touching a human or AI decision (category /
// admin_label / folder / marked_as_lead are frozen once set).
//
// Auth: ?secret=CRON_SECRET like the other crons. Schedule ~every 10 min for a
// recent window; a wider window can be requested with ?days=30 for a deep pass.
//
// Token policy: every Bison call goes through withTeam(), which uses the team's
// per-workspace token and never touches switch-workspace. The super-admin key is
// used ONLY to mint those per-workspace tokens (handled inside lib/bison), never
// for data calls here.

// Folders a genuine reply can be filed under. inbox is the common case; spam
// catches replies Bison misclassified; we intentionally do NOT sweep 'sent'.
const FOLDERS: Array<'inbox' | 'spam'> = ['inbox', 'spam']

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await ready()

  // Migrated to PlusVibe: replies arrive via the external pv-reconciler. The Bison
  // reconcile only re-pulls Bison replies → duplicate unibox rows. Disabled unless
  // BISON_INGEST_ENABLED is set. Returns 200 so any scheduler treats it as success.
  if (!BISON_INGEST_ENABLED) {
    return NextResponse.json({ ok: true, skipped: 'bison_ingest_disabled' })
  }

  // Window: only consider replies received within the last N days (default 3).
  // Bison's list isn't date-filterable server-side, so we filter client-side on
  // date_received and stop scanning a campaign once it's clearly out of window.
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 90)
  const sinceMs = Date.now() - days * 86400_000

  const summary = {
    teams: 0,
    campaigns: 0,
    seen: 0,
    inserted: 0,
    healed: 0,
    repended: 0,
    webhooksRegistered: false,
    errors: [] as string[],
  }

  // Self-heal webhook registration first (idempotent — skips teams already
  // registered to this portal's URL). Best-effort: a registration hiccup must
  // not block reply reconciliation. This keeps every workspace's real-time
  // reply webhook alive even if one was lost or a new client was added.
  try {
    const reg = await registerWebhookAllWorkspaces()
    summary.webhooksRegistered = reg.ok
  } catch (err) {
    summary.errors.push(`webhook register: ${String(err).slice(0, 120)}`)
  }

  for (const [workspaceId, teamId] of Object.entries(PV_TO_BISON_TEAM)) {
    summary.teams++
    // Resolve the owning client once per team (same precedence as mark-as-lead).
    const clientId = await resolveClientId(workspaceId)
    let campaigns: { id: number; name: string }[] = []
    try {
      campaigns = await getCampaigns(teamId)
    } catch (err) {
      summary.errors.push(`team ${teamId} campaigns: ${String(err).slice(0, 120)}`)
      continue
    }

    for (const camp of campaigns) {
      // Pull this campaign's non-automated tracked replies across the relevant
      // folders. Each fetch is its own withTeam() so the Bison gate is held per
      // page-loop, not for the whole team's run — live client reads aren't stalled.
      let replies: BisonReply[] = []
      try {
        for (const folder of FOLDERS) {
          const batch = await withTeam(teamId, () =>
            getCampaignReplies(camp.id, { status: 'not_automated_reply', folder })
          )
          replies = replies.concat(batch)
        }
      } catch (err) {
        summary.errors.push(`team ${teamId} camp ${camp.id}: ${String(err).slice(0, 120)}`)
        continue
      }
      summary.campaigns++

      for (const r of replies) {
        // Tracked-only + in-window. (folder=spam can return tracked replies too.)
        const received = r.date_received ? Date.parse(r.date_received) : NaN
        if (!Number.isNaN(received) && received < sinceMs) continue
        summary.seen++

        const res = await upsertReconciledReply(workspaceId, teamId, r, clientId)
        if (res === 'inserted') summary.inserted++
        else if (res === 'healed') summary.healed++
        if (res === 'repended') summary.repended++
      }
    }

    await pool
      .query(
        `INSERT INTO esp_sync_log (source, workspace_id, status, leads_synced, finished_at) VALUES ($1,$2,$3,$4,NOW())`,
        ['bison-reconcile', workspaceId, 'success', summary.seen]
      )
      .catch(() => {})
  }

  return NextResponse.json({ ok: true, days, ...summary })
}

// Insert a missed reply, or heal an existing row's Bison-owned facts. Returns
// what happened so the caller can count. NEVER writes category / admin_label /
// folder / marked_as_lead on an existing row — those are human/AI-owned.
async function upsertReconciledReply(
  workspaceId: string,
  teamId: string,
  r: BisonReply,
  clientId: string | null,
): Promise<'inserted' | 'healed' | 'repended' | 'noop'> {
  const replyId = String(r.id)
  const folder = r.folder?.toLowerCase() === 'sent' ? 'OUT' : 'IN'
  if (folder !== 'IN') return 'noop' // only inbound replies are triageable
  const senderEmail = (r.from_email_address ?? '').toLowerCase()
  const leadEmail = senderEmail // reconciler keys off the actual sender; webhook does richer lead-matching
  if (!leadEmail) return 'noop'

  const bisonInterested = typeof r.interested === 'boolean' ? r.interested : null
  const bisonAutomated = typeof r.automated_reply === 'boolean' ? r.automated_reply : null
  const subject = r.subject ?? null
  const receivedAt = r.date_received ?? new Date().toISOString()

  // Statement 1: insert-if-missing, else heal Bison-owned facts + bookkeeping for
  // EVERY row (including human-frozen ones — only advisory columns are touched).
  const ins = await pool.query(
    `INSERT INTO unibox_replies
       (bison_team_id, bison_reply_id, workspace_id, client_id, lead_email, sender_email,
        subject, body_preview, classify_state, folder, raw, received_at,
        ingest_source, bison_interested, bison_automated_reply,
        campaign_id, sender_email_id, mailbox_email, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','inbox',$9,$10,'reconcile',$11,$12,$13,$14,$15,NOW())
     ON CONFLICT (bison_team_id, bison_reply_id) DO UPDATE SET
       bison_interested      = EXCLUDED.bison_interested,
       bison_automated_reply = EXCLUDED.bison_automated_reply,
       workspace_id          = COALESCE(unibox_replies.workspace_id, EXCLUDED.workspace_id),
       client_id             = COALESCE(unibox_replies.client_id, EXCLUDED.client_id),
       received_at           = COALESCE(unibox_replies.received_at, EXCLUDED.received_at),
       campaign_id           = COALESCE(unibox_replies.campaign_id, EXCLUDED.campaign_id),
       sender_email_id       = COALESCE(unibox_replies.sender_email_id, EXCLUDED.sender_email_id),
       mailbox_email         = COALESCE(unibox_replies.mailbox_email, EXCLUDED.mailbox_email),
       last_seen_at          = NOW(),
       updated_at            = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      teamId, replyId, workspaceId, clientId, leadEmail, senderEmail || null,
      subject, r.text_body?.slice(0, 500) ?? null,
      JSON.stringify(r), receivedAt,
      bisonInterested, bisonAutomated,
      r.campaign_id != null ? String(r.campaign_id) : null,
      r.sender_email_id != null ? String(r.sender_email_id) : null,
      (r.primary_to_email_address ?? '').toLowerCase() || null,
    ]
  ).catch((err) => {
    console.error(`[reconcile] upsert failed team=${teamId} reply=${replyId}:`, err)
    return null
  })
  if (!ins) return 'noop'
  const wasInserted = ins.rows[0]?.inserted === true
  if (wasInserted) return 'inserted'

  // Statement 2 (guarded): re-queue ONLY rows that previously FAILED to classify
  // and have NOT been ruled on by a human. Never re-pends a done/human-frozen row.
  const rep = await pool.query(
    `UPDATE unibox_replies SET classify_state = 'pending', classify_next_at = NULL, updated_at = NOW()
      WHERE bison_team_id = $1 AND bison_reply_id = $2
        AND classify_state = 'failed' AND admin_label IS NULL AND marked_as_lead = FALSE`,
    [teamId, replyId]
  ).catch(() => null)
  if (rep && rep.rowCount && rep.rowCount > 0) return 'repended'
  return 'healed'
}
