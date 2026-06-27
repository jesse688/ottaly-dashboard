import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { getPlusVibeReceived } from '@/lib/plusvibe'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── REPLY RECONCILIATION AUDIT ───────────────────────────────────────────────
// Two-way check that nothing fell through the cracks:
//   INBOUND  — every reply in PlusVibe (received + Others feeds) made it into our
//              unibox_replies table. Anything in PV but NOT in our table = a
//              MISSED reply.
//   OUTBOUND — every reply a CLIENT sent from the portal actually went live via
//              PlusVibe. portal_emails with direction='OUT', sent_via_portal=true
//              and sent_live <> true = a reply that DIDN'T send (needs manual send).
//
// Auth: ?secret=CRON_SECRET or an admin session.
// ?days=N window (default 7, max 30). ?ws=<id> one workspace (recommended — the
// full sweep hits the PV API for every workspace and can be slow).
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const secretOk = !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!secretOk && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 30)
  const sinceMs = Date.now() - days * 86400_000
  const sinceIso = new Date(sinceMs).toISOString()
  const onlyWs = url.searchParams.get('ws')
  const detail = url.searchParams.get('detail') === '1'   // include the missing items, not just counts

  const wsRows = await pool.query(
    `SELECT DISTINCT pc.workspace_id, MIN(pc.company_name) AS company
       FROM portal_clients pc
      WHERE pc.workspace_id IS NOT NULL AND pc.workspace_id <> ''
      GROUP BY pc.workspace_id`
  )
  const workspaces = (wsRows.rows as { workspace_id: string; company: string | null }[])
    .filter(w => !onlyWs || w.workspace_id === onlyWs)

  type WsResult = {
    workspace_id: string; company: string | null
    // GENUINE campaign replies (the "received" feed) — the number that matters.
    genuine_replies: number; genuine_in_unibox: number; genuine_missing: number
    // Others/spam feed — cold-inbound junk we DON'T fully ingest by design. Informational only.
    other_replies: number; other_in_unibox: number; other_missing: number
    // Legacy combined totals (kept so old dashboards don't break).
    pv_replies: number; in_unibox: number; missing_inbound: number
    client_sent: number; sent_live: number; unsent_outbound: number
    missing?: { from: string; subject: string | null; at: string | null }[]
    unsent?: { lead_email: string; subject: string | null; at: string | null; reason: string | null; body_text?: string | null; body_html?: string | null }[]
    error?: string
  }

  const results: WsResult[] = []

  for (const w of workspaces) {
    const ws = w.workspace_id
    const r: WsResult = {
      workspace_id: ws, company: w.company,
      genuine_replies: 0, genuine_in_unibox: 0, genuine_missing: 0,
      other_replies: 0, other_in_unibox: 0, other_missing: 0,
      pv_replies: 0, in_unibox: 0, missing_inbound: 0,
      client_sent: 0, sent_live: 0, unsent_outbound: 0,
    }
    try {
      // 1. INBOUND — PV's two feeds, keyed by RFC Message-ID and audited SEPARATELY.
      //    "received" = genuine campaign-tracked replies (the real signal).
      //    "other"    = the Others folder, ~99% cold-inbound spam we don't ingest by
      //                 design (only colleague replies matched to a confirmed lead).
      //    Mixing them makes "missing" look catastrophic when it's just spam — so we
      //    report genuine_missing (act on this) apart from other_missing (ignore).
      const [received, others] = await Promise.all([
        getPlusVibeReceived(ws, { sinceMs, emailType: 'received', maxPages: 10 }),
        getPlusVibeReceived(ws, { sinceMs, emailType: 'untracked', maxPages: 5 }),
      ])

      // Build a deduped Message-ID map per feed (skip our own outbound echoes).
      const mapFeed = (feed: typeof received) => {
        const m = new Map<string, { from: string; subject: string | null; at: string | null }>()
        for (const e of feed) {
          const mid = (e.message_id || e.id || '').toLowerCase()
          if (!mid) continue
          const sender = (e.from_address_email || '').toLowerCase()
          const ourMailbox = (e.eaccount || '').toLowerCase()
          if (sender && ourMailbox && sender === ourMailbox) continue
          if (!m.has(mid)) m.set(mid, {
            from: e.from_address_email || '', subject: e.subject ?? null, at: e.timestamp_created ?? null,
          })
        }
        return m
      }
      const genuineMap = mapFeed(received)
      // An item can appear in BOTH feeds; don't double-count it as "other".
      const otherMap = mapFeed(others)
      for (const mid of genuineMap.keys()) otherMap.delete(mid)

      // Look up which Message-IDs we already hold in unibox_replies, in ONE query.
      const allMids = [...new Set([...genuineMap.keys(), ...otherMap.keys()])]
      const haveSet = new Set<string>()
      if (allMids.length) {
        const have = await pool.query(
          `SELECT DISTINCT lower(COALESCE(NULLIF(raw->>'message_id',''), NULLIF(raw->>'raw_message_id',''),
                                          regexp_replace(bison_reply_id, '^pv_', ''))) AS mid
             FROM unibox_replies
            WHERE workspace_id = $1 AND received_at >= $2
              AND lower(COALESCE(NULLIF(raw->>'message_id',''), NULLIF(raw->>'raw_message_id',''),
                                 regexp_replace(bison_reply_id, '^pv_', ''))) = ANY($3::text[])`,
          [ws, sinceIso, allMids]
        )
        for (const x of have.rows as { mid: string }[]) haveSet.add(x.mid)
      }

      const genuineMissing: { from: string; subject: string | null; at: string | null }[] = []
      for (const [mid, info] of genuineMap) {
        if (haveSet.has(mid)) r.genuine_in_unibox++
        else genuineMissing.push(info)
      }
      r.genuine_replies = genuineMap.size
      r.genuine_missing = genuineMissing.length

      for (const mid of otherMap.keys()) {
        if (haveSet.has(mid)) r.other_in_unibox++
        else r.other_missing++
      }
      r.other_replies = otherMap.size

      // Legacy combined fields.
      r.pv_replies = r.genuine_replies + r.other_replies
      r.in_unibox = r.genuine_in_unibox + r.other_in_unibox
      r.missing_inbound = r.genuine_missing + r.other_missing
      // detail now shows the GENUINE misses — the ones worth chasing.
      if (detail) r.missing = genuineMissing.slice(0, 50)

      // 2. OUTBOUND — client replies sent from the portal + their live-send status.
      const out = await pool.query(
        `SELECT lead_email, subject, timestamp_created,
                (sent_live IS TRUE) AS live,
                raw->>'send_reason' AS reason,
                body_text, body_html
           FROM portal_emails
          WHERE workspace_id = $1 AND direction = 'OUT' AND sent_via_portal = true
            AND COALESCE(timestamp_created, NOW()) >= $2`,
        [ws, sinceIso]
      )
      const outRows = out.rows as { lead_email: string; subject: string | null; timestamp_created: string | null; live: boolean; reason: string | null; body_text: string | null; body_html: string | null }[]
      r.client_sent = outRows.length
      r.sent_live = outRows.filter(x => x.live).length
      const unsent = outRows.filter(x => !x.live)
      r.unsent_outbound = unsent.length
      if (detail) r.unsent = unsent.slice(0, 50).map(x => ({
        lead_email: x.lead_email, subject: x.subject, at: x.timestamp_created, reason: x.reason,
        body_text: x.body_text, body_html: x.body_html,
      }))
    } catch (err) {
      r.error = String(err).slice(0, 150)
    }
    results.push(r)
  }

  const totals = results.reduce((t, r) => ({
    genuine_replies: t.genuine_replies + r.genuine_replies,
    genuine_in_unibox: t.genuine_in_unibox + r.genuine_in_unibox,
    genuine_missing: t.genuine_missing + r.genuine_missing,
    other_replies: t.other_replies + r.other_replies,
    other_missing: t.other_missing + r.other_missing,
    pv_replies: t.pv_replies + r.pv_replies,
    in_unibox: t.in_unibox + r.in_unibox,
    missing_inbound: t.missing_inbound + r.missing_inbound,
    client_sent: t.client_sent + r.client_sent,
    sent_live: t.sent_live + r.sent_live,
    unsent_outbound: t.unsent_outbound + r.unsent_outbound,
  }), {
    genuine_replies: 0, genuine_in_unibox: 0, genuine_missing: 0, other_replies: 0, other_missing: 0,
    pv_replies: 0, in_unibox: 0, missing_inbound: 0, client_sent: 0, sent_live: 0, unsent_outbound: 0,
  })

  return NextResponse.json({
    ok: true, days, workspaces: results.length,
    // headline: the ONLY inbound number to act on is genuine_missing. other_* is spam.
    summary: `${totals.genuine_in_unibox}/${totals.genuine_replies} genuine replies captured · `
      + `${totals.genuine_missing} genuine missed · ${totals.other_missing} spam/Others ignored · `
      + `${totals.sent_live}/${totals.client_sent} client replies sent live`,
    totals,
    // Workspaces with a GENUINE problem first (missed real replies or unsent outbound).
    results: results.sort((a, b) =>
      (b.genuine_missing + b.unsent_outbound) - (a.genuine_missing + a.unsent_outbound)),
  })
}
