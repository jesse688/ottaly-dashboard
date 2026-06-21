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
  const start = await clampStartDate(startRaw)
  if (!start || !end) {
    return NextResponse.json({ error: 'start and end required' }, { status: 400 })
  }

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
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM email_events e
        WHERE e.workspace_id = s.workspace_id
          AND lower(e.lead_email) = s.le
          AND e.event_type = 'lead'
      ) THEN s.le END)::int                        AS leads,
      COUNT(DISTINCT s.le)::int                    AS unique_contacts,
      FALSE                                        AS is_approx
    FROM sends s
    GROUP BY s.from_type, s.to_type
  `

  try {
    const { rows: exact } = await pool.query(exactQ, [start, end])
    const rows = exact
      .map((r) => ({
        from_type: r.from_type as string,
        to_type: r.to_type as string,
        sent: +r.sent || 0,
        replies: +r.replies || 0,
        pos_replies: +r.pos_replies || 0,
        bounces: +r.bounces || 0,
        leads: +r.leads || 0,
        unique_contacts: +r.unique_contacts || 0,
        is_approx: false,
      }))
      .sort((a, b) => b.sent - a.sent)
    const hasApprox = rows.some((r) => r.is_approx)

    // Coverage: how many non-seeded events have sender_email populated
    const { rows: cov } = await pool.query(
      `SELECT
         COUNT(*)                                          AS total,
         COUNT(*) FILTER (WHERE sender_email IS NOT NULL) AS with_sender
       FROM email_events
       WHERE event_at >= $1 AND event_at < ($2::date + interval '1 day')
         AND (raw->>'seeded')::boolean IS NOT TRUE`,
      [start, end]
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
