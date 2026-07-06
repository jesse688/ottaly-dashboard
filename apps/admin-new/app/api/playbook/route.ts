import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// ── Playbook ────────────────────────────────────────────────────────────────
// "Where should we put our effort, and who should we send to?" answered by the
// only metric that matters: LEADS PER 1,000 SENT (conversion), not raw lead
// count. 1000 sent → 1 lead (1.0/1k) beats 4000 sent → 1 lead (0.25/1k).
//
// COVERAGE NOTE: sends come from mailbox_daily_stats (per workspace × provider),
// which covers every active client — NOT email_events, whose sent-side only
// fires for ~8 of 33 workspaces (a known ingest gap). Leads are lead-anchored
// (unibox_replies.marked_as_lead) and attributed to the sending mailbox's type.
// The recipient-provider split (Google/MS inbox) only exists in email_events, so
// it's attached per client ONLY where available, and flagged as such.

export const dynamic = 'force-dynamic'

const MIN_SENT = 300 // below this a combo's LPK is noise — flagged low_volume

const SENDER_LABEL: Record<string, string> = { smtp: 'SMTP', google: 'Google', microsoft: 'Microsoft' }
const RECIP_LABEL: Record<string, string> = { email_google: 'Google', email_outlook: 'Microsoft', email_other: 'Other', unknown: 'Unknown' }

interface SenderCombo { sender: string; sent: number; leads: number; lpk: number; low_volume: boolean }
interface RecipRow { recipient: string; leads: number }

export async function GET(req: NextRequest) {
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get('days')) || 30, 1), 90)

  try {
    // Sends per (workspace, sender provider) — FULL client coverage.
    const sentQ = `
      SELECT workspace_id ws, provider AS sender, SUM(sent)::int sent
      FROM mailbox_daily_stats
      WHERE date >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1, 2
      HAVING SUM(sent) > 0
    `
    // Leads per (workspace, sender type) — lead-anchored, mapped via the mailbox.
    const leadsQ = `
      WITH sender AS (
        SELECT DISTINCT ON (lower(email)) lower(email) me, COALESCE(mailbox_type,'smtp') stype
        FROM mailbox_meta ORDER BY lower(email)
      )
      SELECT ur.workspace_id ws, COALESCE(s.stype,'smtp') sender, count(*)::int leads
      FROM unibox_replies ur
      LEFT JOIN sender s ON s.me = lower(ur.mailbox_email)
      WHERE ur.marked_as_lead = TRUE
        AND ur.marked_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1, 2
    `
    // Recipient-provider leads per workspace — ONLY the clients email_events covers.
    const recipQ = `
      WITH recip AS (
        SELECT DISTINCT ON (lower(email)) lower(email) le, mx_provider
        FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
      )
      SELECT ur.workspace_id ws, COALESCE(r.mx_provider,'unknown') recipient, count(*)::int leads
      FROM unibox_replies ur
      LEFT JOIN recip r ON r.le = lower(COALESCE(ur.matched_lead_email, ur.lead_email))
      WHERE ur.marked_as_lead = TRUE
        AND ur.marked_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1, 2
    `
    const wsQ = `SELECT DISTINCT ON (workspace_id) workspace_id, workspace_name
                 FROM mailbox_full WHERE workspace_name IS NOT NULL ORDER BY workspace_id`

    const [{ rows: sends }, { rows: leadRows }, { rows: recipRows }, { rows: wsRows }] = await Promise.all([
      pool.query(sentQ, [days]),
      pool.query(leadsQ, [days]),
      pool.query(recipQ, [days]),
      pool.query(wsQ),
    ])
    const wsName = new Map<string, string>(wsRows.map(r => [r.workspace_id, r.workspace_name]))

    const lpk = (leads: number, sent: number) => sent > 0 ? +((leads * 1000) / sent).toFixed(2) : 0

    // Merge sends + leads by (ws, sender).
    type Cell = { ws: string; sender: string; sent: number; leads: number }
    const cells = new Map<string, Cell>()
    const k = (ws: string, s: string) => `${ws}|${s}`
    for (const r of sends) cells.set(k(r.ws, r.sender), { ws: r.ws, sender: r.sender, sent: r.sent, leads: 0 })
    for (const r of leadRows) {
      const c = cells.get(k(r.ws, r.sender)) ?? { ws: r.ws, sender: r.sender, sent: 0, leads: 0 }
      c.leads += r.leads; cells.set(k(r.ws, r.sender), c)
    }

    // Global sender-type ranking.
    const senderAgg = new Map<string, { sent: number; leads: number }>()
    for (const c of cells.values()) {
      const a = senderAgg.get(c.sender) ?? { sent: 0, leads: 0 }
      a.sent += c.sent; a.leads += c.leads; senderAgg.set(c.sender, a)
    }
    const globalSenders = [...senderAgg.entries()]
      .map(([sender, a]) => ({ sender, label: SENDER_LABEL[sender] ?? sender, sent: a.sent, leads: a.leads, lpk: lpk(a.leads, a.sent) }))
      .sort((x, y) => y.lpk - x.lpk)

    // Recipient leads by workspace (only where email_events / MX data exists).
    const recipByWs = new Map<string, RecipRow[]>()
    for (const r of recipRows) {
      const arr = recipByWs.get(r.ws) ?? []
      arr.push({ recipient: RECIP_LABEL[r.recipient] ?? r.recipient, leads: r.leads })
      recipByWs.set(r.ws, arr)
    }

    // Per-client.
    const byClient = new Map<string, SenderCombo[]>()
    for (const c of cells.values()) {
      const arr = byClient.get(c.ws) ?? []
      arr.push({ sender: SENDER_LABEL[c.sender] ?? c.sender, sent: c.sent, leads: c.leads, lpk: lpk(c.leads, c.sent), low_volume: c.sent < MIN_SENT })
      byClient.set(c.ws, arr)
    }

    const perClient = [...byClient.entries()]
      .map(([ws, combos]) => {
        const totalSent = combos.reduce((s, c) => s + c.sent, 0)
        const totalLeads = combos.reduce((s, c) => s + c.leads, 0)
        const ranked = [...combos].sort((a, b) => b.lpk - a.lpk)
        const solid = ranked.filter(c => !c.low_volume && c.sent > 0)
        const best = solid.find(c => c.leads > 0) ?? null
        const worst = solid.length > 1 ? solid[solid.length - 1] : null
        const recipients = (recipByWs.get(ws) ?? []).sort((a, b) => b.leads - a.leads)
        return {
          workspace_id: ws, client: wsName.get(ws) ?? ws,
          totalSent, totalLeads, lpk: lpk(totalLeads, totalSent),
          best, worst, senders: ranked, recipients,
        }
      })
      .filter(c => c.totalSent > 0)
      .sort((a, b) => b.lpk - a.lpk)

    return NextResponse.json({ days, min_sent: MIN_SENT, globalSenders, perClient })
  } catch (err) {
    console.error('[playbook]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
