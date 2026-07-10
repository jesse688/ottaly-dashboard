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

  const exactQ = `
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
      SELECT ee.workspace_id, ee.campaign_id, lower(ee.lead_email) AS le,
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
      COUNT(*)::int                                AS sent,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM email_events e
        WHERE e.workspace_id = s.workspace_id
          AND lower(e.lead_email) = s.le
          AND e.event_type IN ('reply','positive_reply')
      ) THEN s.le END)::int                        AS replies,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM email_events e
        WHERE e.workspace_id = s.workspace_id
          AND lower(e.lead_email) = s.le
          AND e.event_type = 'positive_reply'
      ) THEN s.le END)::int                        AS pos_replies,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM email_events e
        WHERE e.workspace_id = s.workspace_id
          AND lower(e.lead_email) = s.le
          AND e.event_type = 'bounce'
      ) THEN s.le END)::int                        AS bounces,
      0::int                                       AS leads, -- filled lead-anchored below
      COUNT(DISTINCT s.le)::int                    AS unique_contacts,
      FALSE                                        AS is_approx
    FROM sends s
    GROUP BY s.from_type, s.to_type
  `

  // Leads are counted LEAD-ANCHORED (every unibox_replies.marked_as_lead in the
  // window), NOT send-anchored — a lead's original send often falls outside the
  // window or isn't in email_events, so send-anchoring silently drops most leads
  // (matches the Stats page's direct lead count, not the old always-0 column).
  // Sender type ← the receiving mailbox (mailbox_meta); recipient type ←
  // contacts.mx_provider, same buckets as the send cohort.
  const leadsQ = `
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
      COUNT(*)::int AS leads
    FROM unibox_replies ur
    LEFT JOIN sender_types    st ON st.email_lower = lower(ur.mailbox_email)
    LEFT JOIN recipient_types rt ON rt.email_lower = lower(COALESCE(ur.matched_lead_email, ur.lead_email))
    WHERE ur.marked_as_lead = TRUE
      AND ur.marked_at >= $1 AND ur.marked_at < ($2::date + interval '1 day')
      ${wsFilterUr}
    GROUP BY 1, 2
  `

  try {
    const [{ rows: exact }, { rows: leadRows }] = await Promise.all([
      pool.query(exactQ, params),
      pool.query(leadsQ, params),
    ])
    const leadByCombo = new Map<string, number>()
    for (const l of leadRows) leadByCombo.set(`${l.from_type}|${l.to_type}`, +l.leads || 0)

    const rows = exact
      .map((r) => ({
        from_type: r.from_type as string,
        to_type: r.to_type as string,
        sent: +r.sent || 0,
        replies: +r.replies || 0,
        pos_replies: +r.pos_replies || 0,
        bounces: +r.bounces || 0,
        leads: leadByCombo.get(`${r.from_type}|${r.to_type}`) || 0,
        unique_contacts: +r.unique_contacts || 0,
        is_approx: false,
      }))
      .sort((a, b) => b.sent - a.sent)

    // A lead combo may have NO matching send row (send outside window / not in
    // email_events). Surface those as their own rows so the lead total is honest.
    for (const [key, n] of leadByCombo) {
      const [from_type, to_type] = key.split('|')
      if (!rows.some((r) => r.from_type === from_type && r.to_type === to_type)) {
        rows.push({ from_type, to_type, sent: 0, replies: 0, pos_replies: 0, bounces: 0, leads: n, unique_contacts: 0, is_approx: false })
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
