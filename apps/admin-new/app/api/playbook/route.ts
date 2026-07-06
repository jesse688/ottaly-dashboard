import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// ── Playbook ────────────────────────────────────────────────────────────────
// "Where should we put our effort, and who should we send to?" answered by the
// only metric that matters: LEADS PER 1,000 SENT (conversion), not raw lead
// count. 1000 sent → 1 lead (1.0/1k) beats 4000 sent → 1 lead (0.25/1k).
//
// Returns, for the window:
//   • globalSenders — each sender type (smtp/google/microsoft) ranked by LPK,
//     so you can see which infra is WINNING and which is LACKING.
//   • perClient — for each client, every sender×recipient combo ranked by LPK,
//     with a recommended action (do more / shift / review). Low-volume combos
//     (< MIN_SENT sent) are flagged so a single fluke lead doesn't mislead.
//
// Leads are lead-anchored (unibox_replies.marked_as_lead in-window); sends are
// the non-seeded 'sent' cohort. Recipient provider ← contacts.mx_provider.

export const dynamic = 'force-dynamic'

const MIN_SENT = 300 // below this, a combo's LPK is noise — flagged low_volume

// Pretty labels for the raw bucket codes.
const RECIP_LABEL: Record<string, string> = {
  email_google: 'Google', email_outlook: 'Microsoft', email_other: 'Other',
  unknown: 'Unknown',
}
const SENDER_LABEL: Record<string, string> = {
  smtp: 'SMTP', google: 'Google', microsoft: 'Microsoft',
}

interface Combo {
  sender: string; recipient: string
  sent: number; leads: number; lpk: number; low_volume: boolean
}

export async function GET(req: NextRequest) {
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get('days')) || 30, 1), 90)

  try {
    // Sends per (workspace, sender_type, recipient_type).
    const sentQ = `
      WITH sender AS (
        SELECT DISTINCT ON (lower(email)) lower(email) me, COALESCE(mailbox_type,'smtp') stype
        FROM mailbox_meta ORDER BY lower(email)
      ),
      recip AS (
        SELECT DISTINCT ON (lower(email)) lower(email) le, mx_provider
        FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
      )
      SELECT ee.workspace_id ws,
        COALESCE(s.stype,'smtp') sender,
        COALESCE(r.mx_provider,'unknown') recipient,
        count(*)::int sent
      FROM email_events ee
      LEFT JOIN sender s ON s.me = lower(ee.sender_email)
      LEFT JOIN recip  r ON r.le = lower(ee.lead_email)
      WHERE ee.event_type='sent'
        AND ee.event_at >= CURRENT_DATE - ($1::int - 1)
        AND (ee.raw->>'seeded')::boolean IS NOT TRUE
      GROUP BY 1,2,3
    `
    // Leads per (workspace, sender_type, recipient_type) — lead-anchored.
    const leadsQ = `
      WITH sender AS (
        SELECT DISTINCT ON (lower(email)) lower(email) me, COALESCE(mailbox_type,'smtp') stype
        FROM mailbox_meta ORDER BY lower(email)
      ),
      recip AS (
        SELECT DISTINCT ON (lower(email)) lower(email) le, mx_provider
        FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
      )
      SELECT ur.workspace_id ws,
        COALESCE(s.stype,'smtp') sender,
        COALESCE(r.mx_provider,'unknown') recipient,
        count(*)::int leads
      FROM unibox_replies ur
      LEFT JOIN sender s ON s.me = lower(ur.mailbox_email)
      LEFT JOIN recip  r ON r.le = lower(COALESCE(ur.matched_lead_email, ur.lead_email))
      WHERE ur.marked_as_lead = TRUE
        AND ur.marked_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1,2,3
    `
    const wsQ = `SELECT DISTINCT ON (workspace_id) workspace_id, workspace_name
                 FROM mailbox_full WHERE workspace_name IS NOT NULL ORDER BY workspace_id`

    const [{ rows: sends }, { rows: leads }, { rows: wsRows }] = await Promise.all([
      pool.query(sentQ, [days]),
      pool.query(leadsQ, [days]),
      pool.query(wsQ),
    ])

    const wsName = new Map<string, string>(wsRows.map(r => [r.workspace_id, r.workspace_name]))

    // Merge sends + leads by (ws, sender, recipient).
    type Cell = { ws: string; sender: string; recipient: string; sent: number; leads: number }
    const cells = new Map<string, Cell>()
    const keyOf = (ws: string, s: string, r: string) => `${ws}|${s}|${r}`
    for (const r of sends) {
      cells.set(keyOf(r.ws, r.sender, r.recipient), { ws: r.ws, sender: r.sender, recipient: r.recipient, sent: r.sent, leads: 0 })
    }
    for (const r of leads) {
      const k = keyOf(r.ws, r.sender, r.recipient)
      const c = cells.get(k) ?? { ws: r.ws, sender: r.sender, recipient: r.recipient, sent: 0, leads: 0 }
      c.leads += r.leads
      cells.set(k, c)
    }

    const lpk = (leads: number, sent: number) => sent > 0 ? (leads * 1000) / sent : 0

    // Global sender-type ranking (across all clients).
    const senderAgg = new Map<string, { sent: number; leads: number }>()
    for (const c of cells.values()) {
      const a = senderAgg.get(c.sender) ?? { sent: 0, leads: 0 }
      a.sent += c.sent; a.leads += c.leads; senderAgg.set(c.sender, a)
    }
    const globalSenders = [...senderAgg.entries()]
      .map(([sender, a]) => ({
        sender, label: SENDER_LABEL[sender] ?? sender,
        sent: a.sent, leads: a.leads, lpk: +lpk(a.leads, a.sent).toFixed(2),
      }))
      .sort((x, y) => y.lpk - x.lpk)

    // Per-client combos.
    const byClient = new Map<string, Combo[]>()
    for (const c of cells.values()) {
      const arr = byClient.get(c.ws) ?? []
      arr.push({
        sender: SENDER_LABEL[c.sender] ?? c.sender,
        recipient: RECIP_LABEL[c.recipient] ?? c.recipient,
        sent: c.sent, leads: c.leads, lpk: +lpk(c.leads, c.sent).toFixed(2),
        low_volume: c.sent < MIN_SENT,
      })
      byClient.set(c.ws, arr)
    }

    const perClient = [...byClient.entries()]
      .map(([ws, combos]) => {
        const totalSent = combos.reduce((s, c) => s + c.sent, 0)
        const totalLeads = combos.reduce((s, c) => s + c.leads, 0)
        // Rank by LPK, but only combos with enough volume can be "best/worst".
        const ranked = [...combos].sort((a, b) => b.lpk - a.lpk)
        const solid = ranked.filter(c => !c.low_volume && c.sent > 0)
        const best = solid.find(c => c.leads > 0) ?? null
        const worst = solid.length > 1 ? solid[solid.length - 1] : null
        return {
          workspace_id: ws,
          client: wsName.get(ws) ?? ws,
          totalSent, totalLeads,
          lpk: +lpk(totalLeads, totalSent).toFixed(2),
          best, worst,
          combos: ranked,
        }
      })
      .filter(c => c.totalSent >= MIN_SENT) // hide barely-active clients
      .sort((a, b) => b.lpk - a.lpk)

    return NextResponse.json({ days, min_sent: MIN_SENT, globalSenders, perClient })
  } catch (err) {
    console.error('[playbook]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
