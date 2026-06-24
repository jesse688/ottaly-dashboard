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
