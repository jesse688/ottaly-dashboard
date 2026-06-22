import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'

export const dynamic = 'force-dynamic'

// 3-way bounce classification from the message text (project_bounce_classification.md).
// Most "bounces" are gateway BLOCKS (filtering), not true hard bounces — so we don't
// treat every 5xx as hard. No stored flag; classified live from email_events.raw->>'msg'.
const CLASS_SQL = `
  CASE
    WHEN msg ~* 'spamhaus|spam|blocked|blacklist|reputation|policy|rejected due to|denied|prohibited|content|barracuda|spamtitan|rbl|dnsbl|554 5\\.7|550 5\\.7|access denied'
      THEN 'block'
    WHEN msg ~* 'mailbox full|quota|over quota|temporarily|try again|deferred|greylist|rate limit|too many|timeout|connection|4\\.[0-9]'
      THEN 'soft'
    WHEN msg ~* 'no such user|unknown|does not exist|user not found|invalid (recipient|mailbox|address)|no longer|disabled|550 5\\.1|recipient rejected|mailbox unavailable'
      THEN 'hard'
    ELSE 'other'
  END
`

interface Row { bucket: string; n: string }
interface WsRow { workspace_id: string; workspace_name: string | null; total: string; hard: string; block: string; soft: string }

export async function GET(req: NextRequest) {
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || 30))
  try {
    const base = `
      SELECT workspace_id, lead_email,
             ${CLASS_SQL} AS bucket,
             raw->>'msg' AS msg
      FROM (
        SELECT workspace_id, lead_email, raw, lower(coalesce(raw->>'msg', raw->>'reason', '')) AS msg
        FROM email_events
        WHERE event_type = 'bounce'
          AND event_at >= (now() AT TIME ZONE 'Europe/London')::date - ($1::int - 1)
      ) e
    `

    const totals = await q<Row>(
      `WITH e AS (${base}) SELECT bucket, COUNT(DISTINCT lead_email) AS n FROM e GROUP BY bucket`,
      [days], { tag: 'bounces:totals' },
    )

    const byWs = await q<WsRow>(
      `WITH e AS (${base})
       SELECT e.workspace_id,
              ws.workspace_name,
              COUNT(DISTINCT e.lead_email) AS total,
              COUNT(DISTINCT e.lead_email) FILTER (WHERE bucket='hard')  AS hard,
              COUNT(DISTINCT e.lead_email) FILTER (WHERE bucket='block') AS block,
              COUNT(DISTINCT e.lead_email) FILTER (WHERE bucket='soft')  AS soft
       FROM e
       LEFT JOIN workspace_stats ws ON ws.workspace_id = e.workspace_id
       GROUP BY e.workspace_id, ws.workspace_name
       ORDER BY total DESC`,
      [days], { tag: 'bounces:byWorkspace' },
    )

    const counts = { hard: 0, block: 0, soft: 0, other: 0 }
    for (const r of totals) {
      const k = r.bucket as keyof typeof counts
      if (k in counts) counts[k] = Number(r.n)
    }

    return NextResponse.json({
      days,
      counts,
      total: counts.hard + counts.block + counts.soft + counts.other,
      workspaces: byWs.map(w => ({
        workspace_id: w.workspace_id,
        name: w.workspace_name || w.workspace_id,
        total: Number(w.total),
        hard: Number(w.hard),
        block: Number(w.block),
        soft: Number(w.soft),
      })),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'bounces' }, extra: { days } })
    const msg = err instanceof Error ? err.message : 'Failed to load bounces'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
