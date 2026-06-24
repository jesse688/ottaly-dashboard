import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/notif-audit  (admin session OR ?secret=CRON_SECRET)
//
// Reconstructs EVERY client lead-reply notification that fired, so we can answer
// "what was emailed to which client, and was it legitimate or bogus?". Each
// notification left a portal_meta key `lead_reply_notif_<workspaceId>_<replyId>`
// (see notifyClientOfLeadReply). We parse those keys, join the workspace → client,
// pull the reply's received_at + direction signals from unibox_replies, and label
// each send:
//   • legit       — reply genuinely authored by the lead AND fresh when notified
//   • bogus_old    — reply was HISTORICAL (received long before the notif row was
//                    created) → the Message-ID re-key flood
//   • bogus_outbound — the "reply" was actually OUR mailbox / a non-lead author
//                    (the Jonathan case) → wrong-direction misattribution
//
// Read-only. Safe to run anytime. ?days=N limits to notifs created in last N days.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const viaSecret = !!secret && !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!viaSecret && !(await getAdminSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365)

  // ── PENDING-BACKLOG MODE ?pending=1 ────────────────────────────────────────
  // While Resend was OFF, notifyClientOfLead set every claim to status='failed'
  // (the send returned not-ok). The notify-leads sweeper RE-CLAIMS failed rows,
  // so the instant Resend turns back on it will fire the ENTIRE backlog at once.
  // Some of those are GENUINE leads from the quiet window the client still needs;
  // some may be stale. This mode shows the backlog labelled, WITHOUT sending,
  // so an admin can decide. ?fresh_hours=N (default 24) = the genuine cutoff.
  if (url.searchParams.get('pending') === '1') {
    const freshHours = Math.min(Math.max(parseInt(url.searchParams.get('fresh_hours') || '24', 10) || 24, 1), 720)
    try {
      const q = await pool.query(
        `SELECT n.client_id, n.lead_id, n.status, n.attempts, n.next_retry_at,
                l.email AS lead_email, l.first_name, l.company_name AS lead_company,
                COALESCE(l.first_replied_at, l.created_at) AS lead_at,
                c.company_name AS client, c.workspace_id,
                (COALESCE(l.first_replied_at, l.created_at) >= NOW() - ($1 || ' hours')::interval) AS is_fresh
           FROM portal_lead_notifications n
           JOIN portal_clients c ON c.id = n.client_id AND c.active = true
           LEFT JOIN esp_leads l ON l.id = n.lead_id
          WHERE n.status IN ('failed','sending')
            AND n.attempts < 5
          ORDER BY lead_at DESC NULLS LAST`,
        [String(freshHours)]
      )
      const items = q.rows.map(r => ({
        client: r.client as string | null,
        workspace_id: r.workspace_id as string,
        lead: r.lead_email as string | null,
        lead_name: [r.first_name, r.lead_company].filter(Boolean).join(' · ') || null,
        lead_at: r.lead_at as string | null,
        status: r.status as string,
        attempts: r.attempts as number,
        verdict: r.is_fresh ? 'genuine_send' : 'stale_skip',
      }))
      return NextResponse.json({
        mode: 'pending',
        fresh_hours: freshHours,
        total_pending: items.length,
        genuine_send: items.filter(i => i.verdict === 'genuine_send').length,
        stale_skip: items.filter(i => i.verdict === 'stale_skip').length,
        items,
      })
    } catch (err) {
      console.error('[notif-audit pending]', err)
      return NextResponse.json({ error: 'Database error', detail: String(err).slice(0, 200) }, { status: 500 })
    }
  }

  // ── UNNOTIFIED-LEADS MODE ?unnotified=1 ────────────────────────────────────
  // The pending mode only sees rows that EXIST in portal_lead_notifications. But a
  // genuine lead from the quiet window may have NO notification row at all (never
  // queued), so it would silently never notify. This mode finds recent INTERESTED
  // leads with no 'sent' notification — the true "missed, still needs sending"
  // list — using the SAME eligibility as the notify-leads sweeper (>= client
  // signup, source plusvibe/bison). Read-only. ?hours=N window (default 24).
  if (url.searchParams.get('unnotified') === '1') {
    const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10) || 24, 1), 720)
    try {
      const q = await pool.query(
        `SELECT l.id AS lead_id, l.email AS lead_email, l.first_name, l.company_name AS lead_company,
                COALESCE(l.first_replied_at, l.created_at) AS lead_at,
                c.company_name AS client, c.workspace_id,
                n.status AS notif_status
           FROM esp_leads l
           JOIN portal_clients c ON c.workspace_id = l.workspace_id AND c.active = true
           LEFT JOIN portal_lead_notifications n ON n.client_id = c.id AND n.lead_id = l.id
          WHERE l.source IN ('plusvibe','bison')
            -- Match the CLIENT DASHBOARD's definition of a lead (portal/leads),
            -- not just INTERESTED. A MEETING_BOOKED lead (e.g. Indigo's Nic) shows
            -- in the client view but the narrow INTERESTED-only filter missed it —
            -- which is why this returned 0 while the lead is plainly in the inbox.
            AND (l.status IN ('INTERESTED','MEETING_BOOKED','INFO') OR l.label = 'INTERESTED')
            AND COALESCE(l.first_replied_at, l.created_at) >= c.created_at
            AND COALESCE(l.first_replied_at, l.created_at) >= NOW() - ($1 || ' hours')::interval
            AND (n.id IS NULL OR n.status <> 'sent')
          ORDER BY lead_at DESC NULLS LAST`,
        [String(hours)]
      )
      const items = q.rows.map(r => ({
        client: r.client as string | null,
        workspace_id: r.workspace_id as string,
        lead: r.lead_email as string | null,
        lead_name: [r.first_name, r.lead_company].filter(Boolean).join(' · ') || null,
        lead_at: r.lead_at as string | null,
        notif_status: (r.notif_status as string | null) ?? 'none',
      }))
      return NextResponse.json({ mode: 'unnotified', hours, total: items.length, items })
    } catch (err) {
      console.error('[notif-audit unnotified]', err)
      return NextResponse.json({ error: 'Database error', detail: String(err).slice(0, 200) }, { status: 500 })
    }
  }

  try {
    // Every reply-notification marker, newest first. portal_meta carries a created_at
    // (the moment the notification fired). The key encodes workspace + reply id.
    const metas = await pool.query(
      `SELECT key, created_at
         FROM portal_meta
        WHERE key LIKE 'lead_reply_notif_%'
          AND created_at >= NOW() - ($1 || ' days')::interval
        ORDER BY created_at DESC`,
      [String(days)]
    )

    const rows: Array<{
      notified_at: string
      company: string | null
      client_email: string | null
      workspace_id: string
      reply_key: string
      lead_email: string | null
      sender_email: string | null
      received_at: string | null
      verdict: 'legit' | 'bogus_old' | 'bogus_outbound' | 'unknown'
      reason: string
    }> = []

    for (const m of metas.rows as { key: string; created_at: string }[]) {
      // key = lead_reply_notif_<workspaceId>_<replyId>. workspaceId has no underscore
      // (Mongo-style hex); replyId is the rest (may itself contain underscores, e.g.
      // pv_<message-id>). Strip the fixed prefix, then split off the first segment.
      const rest = m.key.replace(/^lead_reply_notif_/, '')
      const us = rest.indexOf('_')
      const workspaceId = us === -1 ? rest : rest.slice(0, us)
      const replyId = us === -1 ? '' : rest.slice(us + 1)

      // Resolve the actual NOTIFY recipients exactly as notifyClientOfLeadReply
      // does: portal_clients.email (often null in this setup) PLUS every
      // portal_user_access identifier granted to this workspace. The latter is
      // where the real login emails live, so that's who got the bogus message.
      const client = await pool.query(
        `SELECT c.company_name,
                COALESCE(
                  NULLIF(c.email, ''),
                  string_agg(DISTINCT ua.identifier, ', ') FILTER (WHERE ua.identifier ILIKE '%@%')
                ) AS email
           FROM portal_clients c
           LEFT JOIN portal_user_access ua ON ua.client_id = c.id
          WHERE c.workspace_id = $1 AND c.active = true
          GROUP BY c.id, c.company_name, c.email, c.created_at
          ORDER BY c.created_at ASC LIMIT 1`,
        [workspaceId]
      ).catch(() => ({ rows: [] as { company_name: string | null; email: string | null }[] }))

      // The reply row, if we still have it. dedupeKey == bison_reply_id for pv rows.
      const reply = await pool.query(
        `SELECT lead_email, sender_email, received_at, raw
           FROM unibox_replies
          WHERE bison_reply_id = $1 OR bison_reply_id = $2
          LIMIT 1`,
        [replyId, `pv_${replyId}`]
      ).catch(() => ({ rows: [] as { lead_email: string | null; sender_email: string | null; received_at: string | null; raw: unknown }[] }))

      const rr = reply.rows[0]
      const receivedAt = rr?.received_at ? new Date(rr.received_at as string) : null
      const notifiedAt = new Date(m.created_at)

      // Direction: did the LEAD author it, or our mailbox / a non-lead? raw carries
      // from_address_email (author) + eaccount (our mailbox) + lead (campaign lead).
      let verdict: 'legit' | 'bogus_old' | 'bogus_outbound' | 'unknown' = 'unknown'
      let reason = 'reply row no longer present — cannot classify'
      if (rr) {
        const raw = (rr.raw ?? {}) as { from_address_email?: string; eaccount?: string; lead?: string }
        const author = (raw.from_address_email ?? rr.sender_email ?? '').toLowerCase()
        const mailbox = (raw.eaccount ?? '').toLowerCase()
        const campaignLead = (raw.lead ?? rr.lead_email ?? '').toLowerCase()
        const authoredByUs = !!author && !!mailbox && author === mailbox
        const authoredByNonLead = !!author && !!campaignLead && author !== campaignLead
        // Gap between when the reply arrived and when we emailed about it. A genuine
        // fresh notify fires within ~15 min; a big gap = historical re-key flood.
        const gapMs = receivedAt ? notifiedAt.getTime() - receivedAt.getTime() : NaN
        const STALE_MS = 30 * 60_000

        if (authoredByUs || authoredByNonLead) {
          verdict = 'bogus_outbound'
          reason = authoredByUs
            ? `authored by our mailbox (${mailbox}) — outbound misattributed as a lead reply`
            : `authored by ${author}, not the lead (${campaignLead}) — wrong-direction`
        } else if (!Number.isNaN(gapMs) && gapMs > STALE_MS) {
          verdict = 'bogus_old'
          reason = `reply was ${Math.round(gapMs / 60000)} min old when notified — historical re-key flood`
        } else {
          verdict = 'legit'
          reason = 'lead-authored and fresh — correct notification'
        }
      }

      rows.push({
        notified_at: m.created_at,
        company: client.rows[0]?.company_name ?? null,
        client_email: client.rows[0]?.email ?? null,
        workspace_id: workspaceId,
        reply_key: replyId,
        lead_email: rr?.lead_email ?? null,
        sender_email: rr?.sender_email ?? null,
        received_at: rr?.received_at ?? null,
        verdict,
        reason,
      })
    }

    // Summary: which CLIENTS were emailed a bogus notification (the apology list).
    const byClient = new Map<string, { company: string | null; client_email: string | null; bogus: number; legit: number; unknown: number }>()
    for (const r of rows) {
      const k = r.workspace_id
      const cur = byClient.get(k) ?? { company: r.company, client_email: r.client_email, bogus: 0, legit: 0, unknown: 0 }
      if (r.verdict === 'legit') cur.legit++
      else if (r.verdict === 'unknown') cur.unknown++
      else cur.bogus++
      byClient.set(k, cur)
    }
    const apologyList = [...byClient.values()]
      .filter(c => c.bogus > 0)
      .sort((a, b) => b.bogus - a.bogus)

    return NextResponse.json({
      window_days: days,
      total_notifications: rows.length,
      legit: rows.filter(r => r.verdict === 'legit').length,
      bogus_old: rows.filter(r => r.verdict === 'bogus_old').length,
      bogus_outbound: rows.filter(r => r.verdict === 'bogus_outbound').length,
      unknown: rows.filter(r => r.verdict === 'unknown').length,
      apology_list: apologyList,
      notifications: rows,
    })
  } catch (err) {
    console.error('[notif-audit]', err)
    return NextResponse.json({ error: 'Database error', detail: String(err).slice(0, 200) }, { status: 500 })
  }
}

// POST — act on the pending backlog WITHOUT the all-or-nothing sweeper.
//   ?action=send_genuine  → send only leads fresher than fresh_hours (default 24);
//                           leaves stale rows untouched.
//   ?action=skip_stale    → mark stale rows (older than fresh_hours) as 'sent' so
//                           the notify-leads sweeper can NEVER fire them. No email.
// Admin session OR ?secret=CRON_SECRET. Idempotent: send_genuine reuses
// notifyClientOfLead's per-(client,lead) claim, so re-running can't double-send.
export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const viaSecret = !!secret && !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!viaSecret && !(await getAdminSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const action = url.searchParams.get('action')
  const freshHours = Math.min(Math.max(parseInt(url.searchParams.get('fresh_hours') || '24', 10) || 24, 1), 720)
  if (action !== 'send_genuine' && action !== 'skip_stale') {
    return NextResponse.json({ error: 'action must be send_genuine or skip_stale' }, { status: 400 })
  }

  try {
    if (action === 'skip_stale') {
      // Neutralise the STALE backlog: rows whose lead arrived before the cutoff.
      // Set to 'sent' (no email) so the sweeper's failed-row re-claim skips them.
      const r = await pool.query(
        `UPDATE portal_lead_notifications n
            SET status = 'sent', sent_at = NOW()
           FROM esp_leads l
          WHERE l.id = n.lead_id
            AND n.status IN ('failed','sending') AND n.attempts < 5
            AND COALESCE(l.first_replied_at, l.created_at) < NOW() - ($1 || ' hours')::interval`,
        [String(freshHours)]
      )
      return NextResponse.json({ ok: true, action, neutralised: r.rowCount })
    }

    // send_genuine: notify every FRESH interested lead that hasn't been delivered,
    // via the normal path (claims + sends + BCCs the agency). Covers BOTH:
    //   (a) failed/sending backlog rows, AND
    //   (b) interested leads with NO notification row at all (silent misses from
    //       the Resend-off window — e.g. Indigo's lead). The pending view missed (b).
    // Same sweeper eligibility (>= client signup, source plusvibe/bison). Stale
    // leads (older than fresh_hours) are excluded.
    const onlyWs = url.searchParams.get('ws')
    const fresh = await pool.query(
      `SELECT DISTINCT l.id AS lead_id, c.workspace_id
         FROM esp_leads l
         JOIN portal_clients c ON c.workspace_id = l.workspace_id AND c.active = true
         LEFT JOIN portal_lead_notifications n ON n.client_id = c.id AND n.lead_id = l.id
        WHERE l.source IN ('plusvibe','bison')
          -- Same lead definition as the client dashboard (incl. MEETING_BOOKED/INFO).
          AND (l.status IN ('INTERESTED','MEETING_BOOKED','INFO') OR l.label = 'INTERESTED')
          AND COALESCE(l.first_replied_at, l.created_at) >= c.created_at
          AND COALESCE(l.first_replied_at, l.created_at) >= NOW() - ($1 || ' hours')::interval
          AND (n.id IS NULL OR (n.status <> 'sent' AND n.attempts < 5))
          ${onlyWs ? 'AND c.workspace_id = $2' : ''}
        ORDER BY l.id
        LIMIT 200`,
      onlyWs ? [String(freshHours), onlyWs] : [String(freshHours)]
    )
    const { notifyClientOfLead } = await import('@/lib/email')
    let sent = 0
    const results: Array<{ lead_id: string; sent: boolean; reason?: string }> = []
    for (const row of fresh.rows as { lead_id: string; workspace_id: string }[]) {
      try {
        const r = await notifyClientOfLead(row.workspace_id, row.lead_id)
        if (r.sent) sent++
        results.push({ lead_id: row.lead_id, sent: r.sent, reason: r.reason })
      } catch (e) {
        results.push({ lead_id: row.lead_id, sent: false, reason: String(e).slice(0, 80) })
      }
    }
    return NextResponse.json({ ok: true, action, fresh_hours: freshHours, candidates: fresh.rows.length, sent, results })
  } catch (err) {
    console.error('[notif-audit POST]', err)
    return NextResponse.json({ error: 'Database error', detail: String(err).slice(0, 200) }, { status: 500 })
  }
}
