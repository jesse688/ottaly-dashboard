import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// ── Combo Analysis (sender provider × recipient provider) ───────────────────
// DB-direct port of legacy GET /api/combo-analysis. Send-anchored attribution:
// the cohort is every non-seeded 'sent' event in the window; replies / bounces /
// leads are matched per (workspace_id, lead_email) regardless of when those
// follow-up events landed. Exact webhook data only — the old combo_history
// workspace-distribution approximation is intentionally NOT blended in
// (disabled in legacy on 2026-05-28 as inaccurate).

export const dynamic = 'force-dynamic'

// Mirror legacy clampStartDate(): when "show historical" is off and a
// fresh_start_date is set, never query earlier than that date.
async function clampStartDate(startStr: string): Promise<string> {
  if (!startStr) return startStr
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT value FROM app_settings WHERE key = 'fresh_start_date') AS fresh,
         (SELECT value FROM app_settings WHERE key = 'show_historical')  AS show_hist`
    )
    const fresh = rows[0]?.fresh
    const showHist = rows[0]?.show_hist
    // value is JSONB; a string setting comes back as a JS string, a bool as bool
    const freshDate =
      typeof fresh === 'string' ? fresh : fresh == null ? null : String(fresh)
    const showHistorical = showHist === true
    if (showHistorical || !freshDate) return startStr
    return startStr < freshDate ? freshDate : startStr
  } catch {
    return startStr
  }
}

export async function GET(req: NextRequest) {
  const startRaw = String(req.nextUrl.searchParams.get('start') || '')
  const end = String(req.nextUrl.searchParams.get('end') || '')
  // Optional single-client scope. Absent/empty → agency-wide (all workspaces).
  const workspaceId = String(req.nextUrl.searchParams.get('workspace_id') || '').trim()
  const start = await clampStartDate(startRaw)
  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

  // When a workspace is selected, $3 carries it and each query gets an extra
  // AND ee.workspace_id = $3 (indexed via idx_ee_ws_event_at / idx_ee_ws_lead).
  const wsFilter = workspaceId ? `AND ee.workspace_id = $3` : '' // sends + coverage (email_events)
  const wsFilterUr = workspaceId ? `AND ur.workspace_id = $3` : '' // leads (unibox_replies)
  const params = workspaceId ? [start, end, workspaceId] : [start, end]

  // Sends come from email_events (real non-seeded sends). Replies/leads come from
  // unibox_replies — the CLASSIFIED, warmup-stripped source. The old query counted
  // reply/positive_reply events from email_events, but those are ~100% warmup seed
  // replies (raw.seeded=true) and 'positive_reply' isn't even a real event_type,
  // so reply rate was polluted and positive-reply was always 0. Bounces stay on
  // email_events (real bounce events). Sender ESP ← mailbox_meta.mailbox_type,
  // recipient ESP ← contacts.mx_provider.
  const sendsQ = `
    WITH sender_types AS (
      SELECT DISTINCT ON (lower(email))
        lower(email) AS email_lower,
        COALESCE(mailbox_type, 'smtp') AS sender_type
      FROM mailbox_meta ORDER BY lower(email)
    ),
    recipient_types AS (
      SELECT DISTINCT ON (lower(email))
        lower(email) AS email_lower,
        mx_provider  AS recipient_type
      FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
    ),
    sends AS (
      SELECT ee.workspace_id, lower(ee.lead_email) AS le,
        COALESCE(st.sender_type, 'smtp') AS from_type,
        COALESCE(
          rt.recipient_type,
          CASE ee.provider_bucket
            WHEN 'gmail'       THEN 'email_google'
            WHEN 'google'      THEN 'email_google'
            WHEN 'outlook'     THEN 'email_outlook'
            WHEN 'workspace'   THEN 'email_other'
            WHEN 'email_other' THEN 'email_other'
            WHEN 'unknown'     THEN 'unknown'
            ELSE               'email_other'
          END
        ) AS to_type
      FROM email_events ee
      LEFT JOIN sender_types    st ON st.email_lower = lower(ee.sender_email)
      LEFT JOIN recipient_types rt ON rt.email_lower = lower(ee.lead_email)
      WHERE ee.event_type = 'sent'
        AND ee.event_at >= $1 AND ee.event_at < ($2::date + interval '1 day')
        AND (ee.raw->>'seeded')::boolean IS NOT TRUE
        ${wsFilter}
    )
    SELECT s.from_type, s.to_type,
      COUNT(*)::int                    AS sent,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM email_events e
        WHERE e.workspace_id = s.workspace_id
          AND lower(e.lead_email) = s.le
          AND e.event_type = 'bounce'
      ) THEN s.le END)::int            AS bounces,
      COUNT(DISTINCT s.le)::int        AS unique_contacts
    FROM sends s
    GROUP BY s.from_type, s.to_type
  `

  // Replies + leads, classified via unibox_replies. Warmup always excluded.
  //   replies_ooo   = every non-warmup reply (human + OOO/auto) — "Reply Rate (OOO)"
  //   replies_human = non-warmup, non-OOO (real people typed it)  — "Human reply rate"
  //   leads         = marked_as_lead
  const repliesQ = `
    WITH sender_types AS (
      SELECT DISTINCT ON (lower(email)) lower(email) AS email_lower,
        COALESCE(mailbox_type, 'smtp') AS sender_type
      FROM mailbox_meta ORDER BY lower(email)
    ),
    recipient_types AS (
      SELECT DISTINCT ON (lower(email)) lower(email) AS email_lower, mx_provider AS recipient_type
      FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
    )
    SELECT
      COALESCE(st.sender_type, 'smtp') AS from_type,
      COALESCE(rt.recipient_type, 'unknown') AS to_type,
      COUNT(*) FILTER (WHERE COALESCE(ur.admin_label, ur.category) NOT IN ('warmup','warm_up'))::int AS replies_ooo,
      COUNT(*) FILTER (WHERE COALESCE(ur.admin_label, ur.category) NOT IN ('warmup','warm_up','ooo_auto_reply'))::int AS replies_human,
      COUNT(*) FILTER (WHERE ur.marked_as_lead)::int AS leads
    FROM unibox_replies ur
    LEFT JOIN sender_types    st ON st.email_lower = lower(ur.mailbox_email)
    LEFT JOIN recipient_types rt ON rt.email_lower = lower(COALESCE(ur.matched_lead_email, ur.lead_email))
    WHERE ur.received_at >= $1 AND ur.received_at < ($2::date + interval '1 day')
      ${wsFilterUr}
    GROUP BY 1, 2
  `

  try {
    const [{ rows: sendRows }, { rows: replyRows }] = await Promise.all([
      pool.query(sendsQ, params),
      pool.query(repliesQ, params),
    ])
    const replyByCombo = new Map<string, { ooo: number; human: number; leads: number }>()
    for (const r of replyRows) {
      replyByCombo.set(`${r.from_type}|${r.to_type}`, {
        ooo: +r.replies_ooo || 0, human: +r.replies_human || 0, leads: +r.leads || 0,
      })
    }

    const rows = sendRows.map((r) => {
      const rep = replyByCombo.get(`${r.from_type}|${r.to_type}`) || { ooo: 0, human: 0, leads: 0 }
      const sent = +r.sent || 0
      // Replies can exceed sends in-window (a reply's original send predates the
      // window). Flag those rows so the UI can cap the displayed rate at 100%.
      const capped = rep.ooo > sent && sent > 0
      return {
        from_type: r.from_type as string,
        to_type: r.to_type as string,
        sent,
        replies: rep.ooo,          // incl. OOO (primary reply rate)
        replies_human: rep.human,
        pos_replies: rep.human,    // kept for back-compat with any old consumer
        bounces: +r.bounces || 0,
        leads: rep.leads,
        unique_contacts: +r.unique_contacts || 0,
        capped,
        is_approx: false,
      }
    }).sort((a, b) => b.sent - a.sent)

    // Reply/lead combos with NO matching send row (send outside window / unmatched).
    // Surface them so totals are honest, marked capped (no denominator).
    for (const [key, rep] of replyByCombo) {
      const [from_type, to_type] = key.split('|')
      if (!rows.some((r) => r.from_type === from_type && r.to_type === to_type)) {
        rows.push({
          from_type, to_type, sent: 0, replies: rep.ooo, replies_human: rep.human,
          pos_replies: rep.human, bounces: 0, leads: rep.leads, unique_contacts: 0,
          capped: rep.ooo > 0, is_approx: false,
        })
      }
    }
    const hasApprox = rows.some((r) => r.is_approx)

    // Coverage: how many non-seeded events have sender_email populated (scoped
    // to the selected workspace when one is chosen). Aliased ee so wsFilter fits.
    const { rows: cov } = await pool.query(
      `SELECT
         COUNT(*)                                             AS total,
         COUNT(*) FILTER (WHERE ee.sender_email IS NOT NULL) AS with_sender
       FROM email_events ee
       WHERE ee.event_at >= $1 AND ee.event_at < ($2::date + interval '1 day')
         AND (ee.raw->>'seeded')::boolean IS NOT TRUE
         ${wsFilter}`,
      params
    )

    return NextResponse.json({ rows, coverage: cov[0], hasApprox, start, end })
  } catch (err) {
    console.error('[combo-analysis]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database error' },
      { status: 500 }
    )
  }
}
