import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// Verify Split — SMTP Verified vs Catch-All (Safe) performance, read-only.
// Faithful port of legacy GET /api/verify-split. Primary source is the
// contacts table, scoped to contacts last-emailed within the window.
//   summary: one row per email_status with sent/replies/bounces/leads
//   daily:   per-day trend for the two "safe" statuses only
export async function GET(req: NextRequest) {
  const start = String(req.nextUrl.searchParams.get('start') || '')
  const end = String(req.nextUrl.searchParams.get('end') || '')
  if (!start || !end) {
    return NextResponse.json(
      { error: 'start and end required (YYYY-MM-DD)' },
      { status: 400 }
    )
  }

  // Primary source: contacts table. Filter to contacts last-emailed in the
  // period so we see who was actually sent to. email_count = all-time sends
  // to this contact; replies/bounces/leads are filtered to the same window.
  const summaryQ = `
    SELECT
      COALESCE(email_status, 'unknown')                                       AS email_status,
      COUNT(*)::int                                                            AS unique_contacts,
      SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
      COUNT(*) FILTER (WHERE last_reply_at >= $1)::int                        AS replies,
      COUNT(*) FILTER (WHERE bounced_at    >= $1)::int                        AS bounces,
      COUNT(*) FILTER (WHERE marked_as_lead_at >= $1
                          OR (status = 'interested' AND last_reply_at >= $1))::int AS leads
    FROM contacts
    WHERE last_emailed_at >= $1
      AND last_emailed_at < ($2::date + interval '1 day')
    GROUP BY COALESCE(email_status, 'unknown')
    ORDER BY sent DESC
  `

  // Daily trend: contacts emailed each day, split by verification type.
  const dailyQ = `
    SELECT
      last_emailed_at::date                                                    AS day,
      COALESCE(email_status, 'unknown')                                       AS email_status,
      COUNT(*)::int                                                            AS contacts,
      SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
      COUNT(*) FILTER (WHERE last_reply_at >= last_emailed_at)::int           AS replies,
      COUNT(*) FILTER (WHERE bounced_at    >= last_emailed_at)::int           AS bounces
    FROM contacts
    WHERE last_emailed_at >= $1
      AND last_emailed_at < ($2::date + interval '1 day')
      AND email_status IN ('safe', 'safe_catchall')
    GROUP BY 1, 2
    ORDER BY 1, 2
  `

  try {
    const [summaryRes, dailyRes] = await Promise.all([
      pool.query(summaryQ, [start, end]),
      pool.query(dailyQ, [start, end]),
    ])
    return NextResponse.json({
      summary: summaryRes.rows,
      daily: dailyRes.rows,
      start,
      end,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'query failed' },
      { status: 500 }
    )
  }
}
