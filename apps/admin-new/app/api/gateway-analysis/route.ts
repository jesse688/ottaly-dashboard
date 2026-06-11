import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// One row per inbound email gateway (Mimecast, Proofpoint, Google, ...), with
// deliverability metrics computed over every contact we've sent to.
//
// Data-model notes (kept in sync with apps/admin-legacy/scripts/gateway-analysis.js):
//   - "sent to" = contacts.emailed_workspaces <> '{}'  (NOT email_events 'sent',
//     whose webhook coverage is incomplete)
//   - replies live in email_events keyed by lead_email; we count DISTINCT contacts
//     because the rows are heavily duplicated
//   - the gateway comes from gateway_mx_cache.gateway, populated by re-resolving MX
//     (contacts.mx_provider only stores google/outlook/other and hides the gateway)
interface GatewayRow {
  gateway: string
  domains: number
  sent: number
  replied: number
  replied_no_ooo: number
  leads: number
  bounced: number
}

export async function GET() {
  try {
    const res = await pool.query<GatewayRow>(`
      WITH sent AS (
        SELECT c.id,
               lower(split_part(c.email,'@',2)) AS domain,
               lower(c.email)                   AS email,
               c.bounced_at
        FROM contacts c
        WHERE COALESCE(c.emailed_workspaces,'{}'::jsonb) <> '{}'::jsonb
          AND c.email LIKE '%@%'
      ),
      ev AS (
        SELECT lower(lead_email) AS email,
               bool_or(event_type IN ('reply','positive_reply','all_email_replies')) AS replied,
               bool_or(event_type IN ('reply','positive_reply','all_email_replies')
                       AND COALESCE(raw->>'label','') NOT IN ('OUT_OF_OFFICE','AUTOMATIC_REPLY')) AS replied_substantive,
               bool_or(event_type = 'lead'
                       OR raw->>'label' IN ('LEAD','INTERESTED_NONLEAD'))            AS is_lead,
               bool_or(event_type = 'bounce')                                         AS bounced_ev
        FROM email_events
        GROUP BY 1
      ),
      per_contact AS (
        SELECT COALESCE(g.gateway, 'NO MX / unresolved') AS gateway,
               s.domain,
               (e.replied)             AS replied,
               (e.replied_substantive) AS replied_no_ooo,
               (e.is_lead)             AS is_lead,
               (e.bounced_ev OR s.bounced_at IS NOT NULL) AS bounced
        FROM sent s
        JOIN gateway_mx_cache g ON g.domain = s.domain
        LEFT JOIN ev e ON e.email = s.email
      )
      SELECT gateway,
             count(DISTINCT domain)                          AS domains,
             count(*)                                         AS sent,
             count(*) FILTER (WHERE replied)                  AS replied,
             count(*) FILTER (WHERE replied_no_ooo)           AS replied_no_ooo,
             count(*) FILTER (WHERE is_lead)                  AS leads,
             count(*) FILTER (WHERE bounced)                  AS bounced
      FROM per_contact
      GROUP BY gateway
      ORDER BY sent DESC
    `)

    const rows = res.rows.map((r) => {
      const sent = Number(r.sent)
      const replied = Number(r.replied)
      const repliedNoOoo = Number(r.replied_no_ooo)
      const leads = Number(r.leads)
      const bounced = Number(r.bounced)
      return {
        gateway: r.gateway,
        domains: Number(r.domains),
        sent,
        replyRate: sent ? (100 * replied) / sent : 0,
        replyRateNoOoo: sent ? (100 * repliedNoOoo) / sent : 0,
        leadRate: sent ? (100 * leads) / sent : 0,
        rtl: sent ? (1000 * leads) / sent : 0, // leads per 1,000 sent
        bounceRate: sent ? (100 * bounced) / sent : 0,
        replied,
        leads,
        bounced,
      }
    })

    // coverage: how many sent-to domains are resolved vs total
    const cov = await pool.query<{ resolved: string; total: string }>(`
      SELECT
        (SELECT count(*) FROM gateway_mx_cache) AS resolved,
        (SELECT count(DISTINCT lower(split_part(email,'@',2)))
           FROM contacts
          WHERE COALESCE(emailed_workspaces,'{}'::jsonb) <> '{}'::jsonb
            AND email LIKE '%@%') AS total
    `)

    return NextResponse.json({
      gateways: rows,
      coverage: {
        resolved: Number(cov.rows[0]?.resolved ?? 0),
        total: Number(cov.rows[0]?.total ?? 0),
      },
    })
  } catch (err) {
    console.error('[gateway-analysis]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
